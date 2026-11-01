import 'reflect-metadata';

import { Body, Controller, Inject, Post, Req } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PostgresUnitOfWork } from '../src/infrastructure/database/postgres-unit-of-work.js';
import { CASE_REPOSITORY } from '../src/modules/cases/cases.tokens.js';
import { UNIT_OF_WORK } from '../src/infrastructure/database/postgres.tokens.js';
import { PostgresCaseRepository } from '../src/modules/cases/infrastructure/postgres-case.repository.js';
import { CaseService } from '../src/modules/cases/application/case.service.js';
import { AUDIT_EVENT_REPOSITORY } from '../src/modules/audit/audit.tokens.js';
import { PostgresAuditEventRepository } from '../src/modules/audit/infrastructure/postgres-audit-event.repository.js';
import { IdempotencyInterceptor } from '../src/modules/idempotency/idempotency.interceptor.js';
import { IdempotencyService } from '../src/modules/idempotency/application/idempotency.service.js';
import { HmacIdempotencyRequestHasher } from '../src/modules/idempotency/infrastructure/hmac-idempotency-request-hasher.js';
import { PostgresIdempotencyRepository } from '../src/modules/idempotency/infrastructure/postgres-idempotency.repository.js';
import { TenantJsonEncryptionService } from '../src/common/security/tenant-json-encryption.service.js';
import { TenantJsonIdempotencyResponseCipher } from '../src/modules/idempotency/infrastructure/idempotency-response-cipher.js';
import { ConfigService } from '@nestjs/config';

const tenantA = '00000000-0000-4000-8000-000000000001';
const tenantB = '00000000-0000-4000-8000-000000000002';
const userA = '00000000-0000-4000-8000-000000000011';
const userB = '00000000-0000-4000-8000-000000000012';
const viewerId = '00000000-0000-4000-8000-000000000013';
const entityId = '00000000-0000-4000-8000-000000000021';
const caseBId = '00000000-0000-4000-8000-000000000031';
const idempotencyCipher = () => new TenantJsonIdempotencyResponseCipher(new TenantJsonEncryptionService(new ConfigService({
  PII_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 31).toString('base64'),
  PII_ENCRYPTION_KEY_VERSION: 'v1',
})));

@Controller('integration/cases')
class IdempotentCaseController {
  constructor(
    @Inject(CASE_REPOSITORY) private readonly cases: PostgresCaseRepository,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: PostgresUnitOfWork,
    @Inject(AUDIT_EVENT_REPOSITORY) private readonly audit: PostgresAuditEventRepository,
  ) {}

  @Post()
  async create(@Req() req: any, @Body() body: { entityId: string; currency: string }) {
    const { tenantId, actorId } = req.tenantContext;
    return this.unitOfWork.run({ tenantId, actorId }, async (tx) => {
      const created = await this.cases.create(
        tenantId,
        actorId,
        { entityId: body.entityId, currency: body.currency, caseNumber: `IT-${randomUUID()}`, status: 'draft' },
        tx,
      );
      await this.audit.record(tenantId, actorId, {
        type: 'case.created', resourceType: 'credit_case', resourceId: created.id,
        metadata: { status: created.status },
      }, tx);
      return created;
    });
  }
}

describe('Phase 2 PostgreSQL integration', () => {
  let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
  let pool: Pool;
  let app: any;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    await pool.query(`
      CREATE ROLE anon NOLOGIN;
      CREATE ROLE authenticated NOLOGIN;
      CREATE ROLE service_role NOLOGIN BYPASSRLS;
      CREATE SCHEMA auth;
      CREATE TABLE auth.users (id uuid PRIMARY KEY);
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
        $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      GRANT USAGE ON SCHEMA auth TO authenticated, service_role;
      GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated, service_role;
    `);
    await pool.query(readFileSync(resolve(process.cwd(), 'supabase/migrations/0001_init_schema.sql'), 'utf8'));
    await pool.query(readFileSync(resolve(process.cwd(), 'supabase/migrations/20261030120000_add_cases_and_idempotency.sql'), 'utf8'));
    await pool.query(readFileSync(resolve(process.cwd(), 'supabase/migrations/20261030130000_add_outbox_and_jobs.sql'), 'utf8'));
    await pool.query('INSERT INTO auth.users (id) VALUES ($1), ($2), ($3)', [userA, userB, viewerId]);
    await pool.query("INSERT INTO public.tenants (id, name) VALUES ($1, 'Tenant A'), ($2, 'Tenant B')", [tenantA, tenantB]);
    await pool.query('INSERT INTO public.users (auth_user_id) VALUES ($1), ($2), ($3)', [userA, userB, viewerId]);
    await pool.query(
      `INSERT INTO public.memberships (tenant_id, user_id, role)
       SELECT $1, id, 'originator' FROM public.users WHERE auth_user_id = $2`,
      [tenantA, userA],
    );
    await pool.query(
      `INSERT INTO public.memberships (tenant_id, user_id, role)
       SELECT $1, id, 'originator' FROM public.users WHERE auth_user_id = $2`,
      [tenantB, userB],
    );
    await pool.query(
      `INSERT INTO public.memberships (tenant_id, user_id, role)
       SELECT $1, id, 'viewer' FROM public.users WHERE auth_user_id = $2`,
      [tenantA, viewerId],
    );
    await pool.query(
      `INSERT INTO public.credit_cases (id, tenant_id, entity_id, case_number, status, currency)
       VALUES ($1, $2, $3, 'TENANT-B-CASE', 'draft', 'USD')`,
      [caseBId, tenantB, entityId],
    );

    const unitOfWork = new PostgresUnitOfWork(pool);
    const cases = new PostgresCaseRepository();
    const moduleRef = await Test.createTestingModule({
      controllers: [IdempotentCaseController],
      providers: [
        { provide: CASE_REPOSITORY, useValue: cases },
        { provide: UNIT_OF_WORK, useValue: unitOfWork },
        { provide: AUDIT_EVENT_REPOSITORY, useValue: new PostgresAuditEventRepository() },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.use((req: any, _res: any, next: () => void) => {
      req.user = { id: userA };
      req.tenantContext = { tenantId: tenantA, actorId: userA, role: 'originator' };
      next();
    });
    app.useGlobalInterceptors(new IdempotencyInterceptor(new IdempotencyService(
      new PostgresIdempotencyRepository(unitOfWork, idempotencyCipher()),
      new HmacIdempotencyRequestHasher(Buffer.alloc(32, 17)),
    )));
    await app.init();
  }, 120000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await container?.stop();
  });

  it('uses RLS to hide a tenant B case from an authenticated tenant A user', async () => {
    const unitOfWork = new PostgresUnitOfWork(pool);
    const result = await unitOfWork.run({ tenantId: tenantB, actorId: userA }, (tx) =>
      new PostgresCaseRepository().findById(tenantB, userA, caseBId, tx));
    expect(result).toBeNull();
  });

  it('enforces the case creation budget atomically across concurrent database transactions', async () => {
    const unitOfWork = new PostgresUnitOfWork(pool);
    const cases = new PostgresCaseRepository();
    const audit = new PostgresAuditEventRepository();
    const service = new CaseService(cases, audit, unitOfWork);
    const results = await Promise.allSettled(Array.from({ length: 12 }, () =>
      service.create(tenantB, userB, 'originator', { entityId, currency: 'USD' })));
    const created = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    const auditRows = await pool.query(
      `SELECT count(*)::int AS count FROM public.audit_events
       WHERE tenant_id = $1 AND actor_id = $2 AND event_type = 'case.created'`,
      [tenantB, userB],
    );

    expect(created).toHaveLength(10);
    expect(rejected).toHaveLength(2);
    for (const result of rejected) {
      if (result.status === 'rejected') expect(result.reason?.getStatus?.()).toBe(429);
    }
    expect(auditRows.rows[0]?.count).toBe(10);
  });

  it('blocks direct authenticated writes that would bypass the API audit transaction', async () => {
    const unitOfWork = new PostgresUnitOfWork(pool);
    await expect(unitOfWork.run({ tenantId: tenantA, actorId: userA }, (tx) => tx.query(
      `INSERT INTO public.credit_cases (tenant_id, entity_id, case_number, status, currency)
       VALUES ($1, $2, 'DIRECT-CLIENT-WRITE', 'draft', 'USD')`,
      [tenantA, entityId],
    ))).rejects.toThrow();
    await expect(unitOfWork.run({ tenantId: tenantA, actorId: userA }, (tx) => tx.query(
      `INSERT INTO public.audit_events (tenant_id, actor_id, event_type, resource_type, resource_id)
       VALUES ($1, $2, 'forged.event', 'credit_case', $3)`,
      [tenantA, userA, caseBId],
    ))).rejects.toThrow();
  });

  it('purges a bounded batch of expired idempotency rows only for the active tenant and actor', async () => {
    await pool.query(
      `INSERT INTO public.idempotency_keys (tenant_id, actor_id, idempotency_key, request_hash, created_at, expires_at)
       VALUES
         ($1, $2, 'expired-a-0001', repeat('a', 64), now() - interval '2 days', now() - interval '1 day'),
         ($1, $3, 'expired-a-0002', repeat('b', 64), now() - interval '2 days', now() - interval '1 day'),
         ($4, $5, 'expired-b-0001', repeat('c', 64), now() - interval '2 days', now() - interval '1 day')`,
      [tenantA, userA, viewerId, tenantB, userB],
    );
    const repository = new PostgresIdempotencyRepository(new PostgresUnitOfWork(pool), idempotencyCipher());
    const result = await repository.acquire(
      { tenantId: tenantA, actorId: userA, key: 'fresh-key-0001', requestHash: 'c'.repeat(64) },
      new Date(Date.now() + 60_000).toISOString(),
    );
    const rows = await pool.query(
      `SELECT tenant_id, actor_id, count(*)::int AS count FROM public.idempotency_keys
       WHERE idempotency_key LIKE 'expired-%' GROUP BY tenant_id, actor_id ORDER BY tenant_id, actor_id`,
    );
    expect(result.kind).toBe('acquired');
    expect(rows.rows).toEqual([
      { tenant_id: tenantA, actor_id: viewerId, count: 1 },
      { tenant_id: tenantB, actor_id: userB, count: 1 },
    ]);
  });

  it('creates one case for two identical HTTP requests with the same idempotency key', async () => {
    const payload = { entityId, currency: 'USD' };
    const first = await request(app.getHttpServer()).post('/integration/cases').set('Idempotency-Key', 'phase2-test-key-0001').send(payload).expect(201);
    const second = await request(app.getHttpServer()).post('/integration/cases').set('Idempotency-Key', 'phase2-test-key-0001').send(payload).expect(201);
    const { rows } = await pool.query('SELECT count(*)::int AS count FROM public.credit_cases WHERE tenant_id = $1 AND entity_id = $2', [tenantA, entityId]);
    const auditRows = await pool.query('SELECT count(*)::int AS count FROM public.audit_events WHERE tenant_id = $1 AND actor_id = $2 AND resource_id = $3', [tenantA, userA, first.body.id]);
    expect(second.body).toEqual(first.body);
    expect(rows[0]?.count).toBe(1);
    expect(auditRows.rows[0]?.count).toBe(1);
  });

  it('does not expose cases or audit events to the viewer role through direct Supabase reads', async () => {
    const unitOfWork = new PostgresUnitOfWork(pool);
    const visibleCases = await unitOfWork.run({ tenantId: tenantA, actorId: viewerId }, (tx) =>
      tx.query('SELECT id FROM public.credit_cases WHERE tenant_id = $1', [tenantA]));
    const visibleAudit = await unitOfWork.run({ tenantId: tenantA, actorId: viewerId }, (tx) =>
      tx.query('SELECT id FROM public.audit_events WHERE tenant_id = $1', [tenantA]));
    expect(visibleCases.rows).toHaveLength(0);
    expect(visibleAudit.rows).toHaveLength(0);
  });
});
