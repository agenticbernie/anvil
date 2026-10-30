import 'reflect-metadata';

import { createHash, randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { ConflictException } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PostgresUnitOfWork } from '../src/infrastructure/database/postgres-unit-of-work.js';
import { PostgresAuditEventRepository } from '../src/modules/audit/infrastructure/postgres-audit-event.repository.js';
import { DocumentTextCipherService } from '../src/modules/documents/infrastructure/document-text-cipher.service.js';
import { DocumentEncryptionService } from '../src/modules/documents/infrastructure/document-encryption.service.js';
import type { ExtractionJobPayload } from '../src/modules/extraction/application/extraction.types.js';
import { ExtractionService } from '../src/modules/extraction/application/extraction.service.js';
import { FakeExtractionProvider } from '../src/modules/extraction/infrastructure/fake-extraction.provider.js';
import { PostgresExtractionRepository } from '../src/modules/extraction/infrastructure/postgres-extraction.repository.js';
import { TenantJsonEncryptionService } from '../src/modules/extraction/infrastructure/tenant-json-encryption.service.js';
import { FakeMemoProvider } from '../src/modules/memos/infrastructure/fake-memo.provider.js';
import { PostgresMemoRepository } from '../src/modules/memos/infrastructure/postgres-memo.repository.js';
import { MemoService } from '../src/modules/memos/application/memo.service.js';
import { ExtractionWorker } from '../src/workers/extraction.worker.js';
import { MemoWorker } from '../src/workers/memo.worker.js';
import { PostgresCaseRepository } from '../src/modules/cases/infrastructure/postgres-case.repository.js';
import { PostgresOutboxRepository } from '../src/modules/documents/infrastructure/postgres-outbox.repository.js';
import type { MemoGenerationPayload } from '../src/modules/memos/application/memo.types.js';
import { FactsController } from '../src/modules/extraction/api/facts.controller.js';
import { MemosController } from '../src/modules/memos/api/memos.controller.js';
import { IdempotencyInterceptor } from '../src/modules/idempotency/idempotency.interceptor.js';
import { IdempotencyService } from '../src/modules/idempotency/application/idempotency.service.js';
import { PostgresIdempotencyRepository } from '../src/modules/idempotency/infrastructure/postgres-idempotency.repository.js';
import { SupabaseAuthGuard } from '../src/modules/auth/supabase-auth.guard.js';
import { TenantContextGuard } from '../src/modules/auth/tenant-context.guard.js';
import { RolesGuard } from '../src/modules/auth/roles.guard.js';
import { hashIdempotencyRequest, hashLegacyIdempotencyRequest } from '../src/modules/cases/idempotency/idempotency-policy.js';
import { HmacIdempotencyRequestHasher } from '../src/modules/idempotency/infrastructure/hmac-idempotency-request-hasher.js';
import { TenantJsonIdempotencyResponseCipher } from '../src/modules/idempotency/infrastructure/idempotency-response-cipher.js';
import { backfillIdempotencyResponseCache } from '../src/modules/idempotency/infrastructure/idempotency-response-cache-backfill.js';

const tenantId = '00000000-0000-4000-8000-000000000001';
const actorId = '00000000-0000-4000-8000-000000000011';
const caseId = '00000000-0000-4000-8000-000000000021';
const entityId = '00000000-0000-4000-8000-000000000031';
const documentId = '00000000-0000-4000-8000-000000000041';
const documentVersionId = '00000000-0000-4000-8000-000000000051';
const processingJobId = '00000000-0000-4000-8000-000000000061';
const piiKey = Buffer.alloc(32, 73).toString('base64');
describe('Phase 4 extraction worker integration', () => {
  let postgres: Awaited<ReturnType<PostgreSqlContainer['start']>>;
  let pool: Pool;
  let worker: ExtractionWorker;
  let memoWorker: MemoWorker;
  let repository: PostgresExtractionRepository;
  let extractionService: ExtractionService;
  let memoService: MemoService;
  let unitOfWork: PostgresUnitOfWork;
  let idempotencyResponseCipher: TenantJsonIdempotencyResponseCipher;
  let idempotencyService: IdempotencyService;
  let api: INestApplication;
  let tenantBId: string;
  let actorBId: string;

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer('postgres:16-alpine').start();
    pool = new Pool({ connectionString: postgres.getConnectionUri() });
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
    for (const migration of [
      '0001_init_schema.sql',
      '20261030120000_add_cases_and_idempotency.sql',
      '20261030130000_add_outbox_and_jobs.sql',
      '20261030140000_secure_document_uploads.sql',
      '20261030150000_harden_document_upload_lifecycle.sql',
      '20261030160000_add_extraction_and_memo_tables.sql',
      '20261030180000_bound_memo_generation_requests.sql',
    ]) await pool.query(readFileSync(resolve(process.cwd(), 'supabase/migrations', migration), 'utf8'));

    tenantBId = randomUUID();
    actorBId = randomUUID();
    await pool.query('INSERT INTO auth.users (id) VALUES ($1), ($2)', [actorId, actorBId]);
    await pool.query('INSERT INTO public.tenants (id, name) VALUES ($1, $2), ($3, $4)', [tenantId, 'Phase 4 tenant A', tenantBId, 'Phase 4 tenant B']);
    await pool.query('INSERT INTO public.users (auth_user_id) VALUES ($1), ($2)', [actorId, actorBId]);
    await pool.query(
      `INSERT INTO public.memberships (tenant_id, user_id, role)
       SELECT $1, id, 'analyst' FROM public.users WHERE auth_user_id = $2`, [tenantId, actorId],
    );
    await pool.query(
      `INSERT INTO public.memberships (tenant_id, user_id, role)
       SELECT $1, id, 'analyst' FROM public.users WHERE auth_user_id = $2`, [tenantBId, actorBId],
    );
    await pool.query(
      `INSERT INTO public.credit_cases (id, tenant_id, entity_id, case_number, status, currency)
       VALUES ($1, $2, $3, 'PHASE4-CASE-A', 'draft', 'USD')`, [caseId, tenantId, entityId],
    );
    const config = new ConfigService({ PII_ENCRYPTION_KEY_BASE64: piiKey, PII_ENCRYPTION_KEY_VERSION: 'v1' });
    const documentEncryption = new DocumentEncryptionService(config);
    const keyMaterial = documentEncryption.createUploadMaterial(tenantId, documentId);
    await pool.query(
      `INSERT INTO public.documents
         (id, tenant_id, case_id, uploaded_by, object_key, final_object_key, content_type, size_bytes, storage_size_bytes,
          sha256, wrapped_data_key, encryption_nonce, encryption_key_version, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'application/pdf', 1, 17, $7, $8, $9, 'v1', 'processed')`,
      [documentId, tenantId, caseId, actorId, `tenant/${tenantId}/source/${documentId}`, `tenants/${tenantId}/cases/${caseId}/documents/finalized/${documentId}`,
        'a'.repeat(64), keyMaterial.wrappedDataKey, keyMaterial.nonceBase64],
    );
    const text = 'Audited evidence: the portfolio includes 100 GPU units on page 1.';
    const textCipher = new DocumentTextCipherService(config);
    const encrypted = textCipher.encrypt(tenantId, documentVersionId, text);
    unitOfWork = new PostgresUnitOfWork(pool);
    await unitOfWork.run({ tenantId, actorId }, async (tx) => tx.withBackendRole(async (backend) => {
      await backend.query(
        `INSERT INTO public.document_versions
           (id, tenant_id, case_id, document_id, version_number, source_text_ciphertext, source_text_nonce,
            source_text_key_version, source_text_hash, source_page_count, source_kind)
         VALUES ($1, $2, $3, $4, 1, $5, $6, $7, $8, 1, 'text')`,
        [documentVersionId, tenantId, caseId, documentId, encrypted.ciphertext, encrypted.nonce, encrypted.keyVersion,
          createHash('sha256').update(text).digest('hex')],
      );
    }));

    const valueCipher = new TenantJsonEncryptionService(config);
    repository = new PostgresExtractionRepository(valueCipher);
    extractionService = new ExtractionService(
      repository, new FakeExtractionProvider(0), valueCipher, textCipher, new PostgresAuditEventRepository(),
      { create: async () => undefined }, unitOfWork, 'fake-extraction-v1',
    );
    worker = new ExtractionWorker(extractionService, {} as never);
    const memoRepository = new PostgresMemoRepository(valueCipher);
    memoService = new MemoService(
      memoRepository, new FakeMemoProvider(0), valueCipher, repository, new PostgresCaseRepository(),
      new PostgresOutboxRepository(pool), new PostgresAuditEventRepository(), unitOfWork,
    );
    memoWorker = new MemoWorker(memoService, {} as never);

    idempotencyResponseCipher = new TenantJsonIdempotencyResponseCipher(valueCipher);
    idempotencyService = new IdempotencyService(
      new PostgresIdempotencyRepository(unitOfWork, idempotencyResponseCipher),
      new HmacIdempotencyRequestHasher(Buffer.alloc(32, 19)),
    );
    const moduleRef = await Test.createTestingModule({
      controllers: [FactsController, MemosController],
      providers: [
        { provide: ExtractionService, useValue: extractionService },
        { provide: MemoService, useValue: memoService },
        { provide: IdempotencyService, useValue: idempotencyService },
        { provide: IdempotencyInterceptor, inject: [IdempotencyService], useFactory: (service: IdempotencyService) => new IdempotencyInterceptor(service) },
      ],
    })
      .overrideGuard(SupabaseAuthGuard).useValue({ canActivate: () => true })
      .overrideGuard(TenantContextGuard).useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard).useValue({ canActivate: () => true })
      .compile();
    api = moduleRef.createNestApplication();
    api.setGlobalPrefix('v1');
    api.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
    api.use((req: any, _res: any, next: () => void) => {
      req.user = { id: actorId };
      req.tenantContext = { tenantId, actorId, role: 'analyst' };
      next();
    });
    await api.init();
  }, 180_000);

  afterAll(async () => {
    await api?.close();
    await pool?.end();
    await postgres?.stop();
  });

  it('re-encrypts legacy idempotency response caches and keeps exact replay behavior', async () => {
    const requestBody = { normalizedValue: 'Sensitive Borrower Ltd', reviewStatus: 'verified' };
    const requestHash = hashLegacyIdempotencyRequest('PATCH', '/v1/facts/legacy', requestBody);
    const key = 'phase5-legacy-cache-0001';
    const legacyBody = { id: randomUUID(), normalizedValue: 'Sensitive Borrower Ltd', rawValue: { taxId: '12-3456789' } };
    await pool.query(
      `INSERT INTO public.idempotency_keys
         (tenant_id, actor_id, idempotency_key, request_hash, response_status, response_body, expires_at)
       VALUES ($1, $2, $3, $4, 200, $5::jsonb, now() + interval '1 hour')`,
      [tenantId, actorId, key, requestHash, JSON.stringify(legacyBody)],
    );

    const preview = await backfillIdempotencyResponseCache(pool, idempotencyResponseCipher, false);
    const unchanged = await pool.query<{ response_body: unknown }>(
      `SELECT response_body FROM public.idempotency_keys WHERE tenant_id = $1 AND actor_id = $2 AND idempotency_key = $3`,
      [tenantId, actorId, key],
    );
    expect(preview).toMatchObject({ encrypted: 1, applied: false });
    expect(unchanged.rows[0]?.response_body).toEqual(legacyBody);

    const result = await backfillIdempotencyResponseCache(pool, idempotencyResponseCipher, true);
    const cached = await pool.query<{ response_body: unknown }>(
      `SELECT response_body FROM public.idempotency_keys WHERE tenant_id = $1 AND actor_id = $2 AND idempotency_key = $3`,
      [tenantId, actorId, key],
    );
    expect(result).toMatchObject({ encrypted: 1, applied: true });
    expect(JSON.stringify(cached.rows[0]?.response_body)).not.toContain('Sensitive Borrower Ltd');
    expect(JSON.stringify(cached.rows[0]?.response_body)).not.toContain('12-3456789');
    expect(idempotencyResponseCipher.isEncryptedResponse(cached.rows[0]?.response_body)).toBe(true);

    await pool.query(readFileSync(resolve(process.cwd(), 'supabase/migrations/20261030170000_encrypt_idempotency_responses.sql'), 'utf8'));
    await expect(pool.query(
      `INSERT INTO public.idempotency_keys
         (tenant_id, actor_id, idempotency_key, request_hash, response_status, response_body, expires_at)
       VALUES ($1, $2, 'plaintext-after-migration', repeat('c', 64), 200, '{"private":true}'::jsonb, now() + interval '1 hour')`,
      [tenantId, actorId],
    )).rejects.toThrow();
    const encryptedWithExtraPlaintext = {
      ...idempotencyResponseCipher.encrypt({ tenantId, actorId, key: 'extra-plaintext-0001', requestHash: 'd'.repeat(64) }, null),
      leakedValue: 'Sensitive Borrower Ltd',
    };
    await expect(pool.query(
      `INSERT INTO public.idempotency_keys
         (tenant_id, actor_id, idempotency_key, request_hash, response_status, response_body, expires_at)
       VALUES ($1, $2, 'extra-plaintext-0001', repeat('d', 64), 200, $3::jsonb, now() + interval '1 hour')`,
      [tenantId, actorId, JSON.stringify(encryptedWithExtraPlaintext)],
    )).rejects.toThrow();
    await expect(idempotencyService.begin({
      tenantId, actorId, key, method: 'PATCH', route: '/v1/facts/legacy', body: requestBody,
    })).resolves.toEqual({ kind: 'replay', status: 200, body: legacyBody });
  });

  it('rate limits memo-generation requests before recording another outbox or audit row', async () => {
    for (let requestIndex = 0; requestIndex < 10; requestIndex += 1) {
      await memoService.requestGeneration(tenantId, actorId, caseId);
    }
    const before = await pool.query(
      `SELECT (SELECT count(*)::int FROM public.outbox_events WHERE tenant_id = $1 AND event_type = 'memo.generate.requested') AS outbox_count,
              (SELECT count(*)::int FROM public.audit_events WHERE tenant_id = $1 AND event_type = 'memo.generation_requested') AS audit_count`,
      [tenantId],
    );

    await expect(memoService.requestGeneration(tenantId, actorId, caseId)).rejects.toMatchObject({ status: 429 });

    const after = await pool.query(
      `SELECT (SELECT count(*)::int FROM public.outbox_events WHERE tenant_id = $1 AND event_type = 'memo.generate.requested') AS outbox_count,
              (SELECT count(*)::int FROM public.audit_events WHERE tenant_id = $1 AND event_type = 'memo.generation_requested') AS audit_count`,
      [tenantId],
    );
    expect(after.rows).toEqual(before.rows);
    expect(after.rows[0]).toEqual({ outbox_count: 10, audit_count: 10 });
  });

  it('processes an extraction worker payload, persists encrypted facts with provenance, and writes audit events', async () => {
    const payload: ExtractionJobPayload = { tenantId, actorId, caseId, documentId, documentVersionId, processingJobId };
    await expect(worker.processJob(payload)).resolves.toMatchObject({ status: 'succeeded', factCount: 2 });

    const runs = await pool.query('SELECT id, status, model_name, prompt_hash FROM public.extraction_runs WHERE tenant_id = $1 AND document_version_id = $2', [tenantId, documentVersionId]);
    const facts = await pool.query('SELECT extraction_run_id, field_name, source_page, confidence, review_status, raw_value ? \'ciphertext\' AS encrypted FROM public.extracted_facts WHERE tenant_id = $1 AND case_id = $2 ORDER BY field_name', [tenantId, caseId]);
    const audits = await pool.query("SELECT count(*)::int AS count FROM public.audit_events WHERE tenant_id = $1 AND event_type = 'fact.created'", [tenantId]);
    expect(runs.rows).toHaveLength(1);
    expect(runs.rows[0]).toMatchObject({ status: 'succeeded', model_name: 'fake-extraction-v1' });
    expect(facts.rows).toHaveLength(2);
    expect(facts.rows.every((row) => row.encrypted === true && row.source_page === 1 && Number(row.confidence) > 0)).toBe(true);
    expect(facts.rows.every((row) => row.extraction_run_id === runs.rows[0]?.id && row.review_status === 'unverified')).toBe(true);
    expect(audits.rows[0]?.count).toBe(2);
    const decrypted = await new PostgresUnitOfWork(pool).run({ tenantId, actorId }, (tx) => repository.listFactsForCase(tenantId, actorId, caseId, tx));
    expect(decrypted).toHaveLength(2);
    expect(decrypted.find((row) => row.fieldName === 'gpu_count')?.normalizedValue).toBe(100);
  });

  it('does not duplicate extraction runs, facts, or audit events when the same input is retried', async () => {
    const payload: ExtractionJobPayload = { tenantId, actorId, caseId, documentId, documentVersionId, processingJobId };
    await expect(worker.processJob(payload)).resolves.toMatchObject({ status: 'already_processed' });

    const counts = await pool.query(
      `SELECT (SELECT count(*) FROM public.extraction_runs WHERE tenant_id = $1 AND document_version_id = $2)::int AS runs,
              (SELECT count(*) FROM public.extracted_facts WHERE tenant_id = $1 AND case_id = $3)::int AS facts,
              (SELECT count(*) FROM public.audit_events WHERE tenant_id = $1 AND event_type = 'fact.created')::int AS audits`,
      [tenantId, documentVersionId, caseId],
    );
    expect(counts.rows).toEqual([{ runs: 1, facts: 2, audits: 2 }]);
  });

  it('keeps document versions inaccessible across tenant scopes', async () => {
    const unitOfWork = new PostgresUnitOfWork(pool);
    const result = await unitOfWork.run({ tenantId: tenantBId, actorId: actorBId }, (tx) =>
      repository.findDocumentVersion(tenantBId, actorBId, documentVersionId, tx));
    expect(result).toBeNull();
  });

  it('generates an encrypted memo draft and reuses it for the same input snapshot', async () => {
    const payload: MemoGenerationPayload = { tenantId, actorId, caseId, generationKey: randomUUID() };
    await expect(memoWorker.processJob(payload)).resolves.toMatchObject({ status: 'draft' });
    await expect(memoWorker.processJob(payload)).resolves.toMatchObject({ status: 'already_exists' });

    const rows = await pool.query(
      `SELECT id, status, version_number, content ? 'ciphertext' AS encrypted
       FROM public.memo_versions WHERE tenant_id = $1 AND case_id = $2`, [tenantId, caseId],
    );
    const auditCount = await pool.query("SELECT count(*)::int AS count FROM public.audit_events WHERE tenant_id = $1 AND event_type = 'memo.generated'", [tenantId]);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({ status: 'draft', version_number: 1, encrypted: true });
    expect(auditCount.rows[0]?.count).toBe(1);

    const memoId = rows.rows[0]?.id;
    if (!memoId) throw new Error('Memo fixture was not created.');
    const response = await request(api.getHttpServer()).get(`/v1/memos/${memoId}`).expect(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body.content.borrower_overview).toBeTruthy();
  });

  it.each(['extraction_runs', 'extracted_facts', 'memo_versions'] as const)(
    'enforces RLS against tenant B reads of tenant A %s rows', async (table) => {
      const visible = await unitOfWork.run({ tenantId: tenantBId, actorId: actorBId }, (tx) =>
        tx.withBackendRole((backend) =>
          backend.query(`SELECT id FROM public.${table} WHERE tenant_id = $1 AND case_id = $2`, [tenantId, caseId])));
      expect(visible.rows).toHaveLength(0);
    },
  );

  it('requires an idempotency key and replays a repeated fact update without a second audit write', async () => {
    const factResult = await pool.query<{ id: string }>(
      `SELECT id FROM public.extracted_facts WHERE tenant_id = $1 AND case_id = $2 AND field_name = 'gpu_count'`,
      [tenantId, caseId],
    );
    const factId = factResult.rows[0]?.id;
    if (!factId) throw new Error('Fact fixture was not created.');

    await request(api.getHttpServer()).patch(`/v1/facts/${factId}`).send({ reviewStatus: 'verified' }).expect(400);

    const payload = { normalizedValue: 101, reviewStatus: 'verified' };
    const first = await request(api.getHttpServer()).patch(`/v1/facts/${factId}`)
      .set('Idempotency-Key', 'phase5-fact-update-0001').send(payload).expect(200);
    const second = await request(api.getHttpServer()).patch(`/v1/facts/${factId}`)
      .set('Idempotency-Key', 'phase5-fact-update-0001').send(payload).expect(200);
    await request(api.getHttpServer()).patch(`/v1/facts/${factId}`)
      .set('Idempotency-Key', 'phase5-fact-update-0001').send({ ...payload, normalizedValue: 102 }).expect(409);
    const count = await pool.query(
      `SELECT count(*)::int AS count FROM public.audit_events WHERE tenant_id = $1 AND event_type = 'fact.verified' AND resource_id = $2`,
      [tenantId, factId],
    );
    expect(second.body).toEqual(first.body);
    expect(first.headers['cache-control']).toBe('no-store');
    expect(second.headers['cache-control']).toBe('no-store');
    expect(second.body.normalizedValue).toBe(101);
    expect(count.rows[0]?.count).toBe(1);
    const cached = await pool.query<{ request_hash: string; response_body: unknown }>(
      `SELECT request_hash, response_body FROM public.idempotency_keys WHERE tenant_id = $1 AND actor_id = $2 AND idempotency_key = $3`,
      [tenantId, actorId, 'phase5-fact-update-0001'],
    );
    expect(JSON.stringify(cached.rows[0]?.response_body)).not.toContain('101');
    expect(idempotencyResponseCipher.isEncryptedResponse(cached.rows[0]?.response_body)).toBe(true);
    expect(cached.rows[0]?.request_hash).toBe(hashIdempotencyRequest(
      'PATCH', `/v1/facts/${factId}`, payload, Buffer.alloc(32, 19),
    ));
    expect(cached.rows[0]?.request_hash).not.toBe(hashLegacyIdempotencyRequest('PATCH', `/v1/facts/${factId}`, payload));

    const rotatedService = new IdempotencyService(
      new PostgresIdempotencyRepository(unitOfWork, idempotencyResponseCipher),
      new HmacIdempotencyRequestHasher(Buffer.alloc(32, 20), [Buffer.alloc(32, 19)]),
    );
    await expect(rotatedService.begin({
      tenantId, actorId, key: 'phase5-fact-update-0001', method: 'PATCH', route: `/v1/facts/${factId}`, body: payload,
    })).resolves.toMatchObject({ kind: 'replay', status: 200, body: { normalizedValue: 101 } });
  });

  it('serializes concurrent fact review requests and caps durable audit writes per actor', async () => {
    const factResult = await pool.query<{ id: string }>(
      `SELECT id FROM public.extracted_facts WHERE tenant_id = $1 AND case_id = $2 AND field_name = 'gpu_count'`,
      [tenantId, caseId],
    );
    const factId = factResult.rows[0]?.id;
    if (!factId) throw new Error('Fact fixture was not created.');

    const results = await Promise.all(Array.from({ length: 12 }, (_, index) =>
      request(api.getHttpServer()).patch(`/v1/facts/${factId}`)
        .set('Idempotency-Key', `phase5-fact-budget-${String(index).padStart(4, '0')}`)
        .send({ normalizedValue: 200 + index, reviewStatus: 'verified' })));
    expect(results.filter((result) => result.status === 200)).toHaveLength(9);
    expect(results.filter((result) => result.status === 429)).toHaveLength(3);

    const counts = await pool.query(
      `SELECT count(*) FILTER (WHERE actor_id = $2)::int AS actor_count,
              count(*)::int AS tenant_count
       FROM public.audit_events WHERE tenant_id = $1 AND event_type IN ('fact.updated', 'fact.verified')`,
      [tenantId, actorId],
    );
    expect(counts.rows[0]).toEqual({ actor_count: 10, tenant_count: 10 });
  });

  it('serializes critical fact review with memo approval so a concurrent conflict cannot bypass the gate', async () => {
    const factResult = await pool.query<{ id: string }>(
      `SELECT id FROM public.extracted_facts WHERE tenant_id = $1 AND case_id = $2 AND field_name = 'annual_revenue'`,
      [tenantId, caseId],
    );
    const memoResult = await pool.query<{ id: string }>(
      `SELECT id FROM public.memo_versions WHERE tenant_id = $1 AND case_id = $2 AND status = 'draft'`,
      [tenantId, caseId],
    );
    const factId = factResult.rows[0]?.id;
    const memoId = memoResult.rows[0]?.id;
    if (!factId || !memoId) throw new Error('Concurrency fixtures were not created.');

    let releaseConflict!: () => void;
    let signalConflictUpdated!: () => void;
    const conflictHold = new Promise<void>((resolve) => { releaseConflict = resolve; });
    const conflictUpdated = new Promise<void>((resolve) => { signalConflictUpdated = resolve; });
    let conflictTransaction: Promise<unknown> | undefined;
    let approval: Promise<{ kind: 'approved' } | { kind: 'rejected'; error: unknown }> | undefined;
    let approvalSettled = false;
    try {
      conflictTransaction = unitOfWork.run({ tenantId, actorId }, async (tx) => {
        const updated = await repository.updateFact(tenantId, actorId, factId, { reviewStatus: 'conflict' }, tx);
        signalConflictUpdated();
        await conflictHold;
        return updated;
      });
      await conflictUpdated;

      approval = memoService.approve(tenantId, actorId, memoId).then(
        () => { approvalSettled = true; return { kind: 'approved' as const }; },
        (error: unknown) => { approvalSettled = true; return { kind: 'rejected' as const, error }; },
      );
      const approvalWaitState = await waitForApprovalLockOrSettlement(pool, () => approvalSettled);
      expect(approvalWaitState).toBe('waiting');
    } finally {
      releaseConflict();
      if (conflictTransaction) await conflictTransaction.catch(() => undefined);
      if (approval) await approval.catch(() => undefined);
    }

    if (!conflictTransaction || !approval) throw new Error('Concurrency operations were not started.');
    await expect(conflictTransaction).resolves.toMatchObject({ reviewStatus: 'conflict' });
    const approvalResult = await approval;
    expect(approvalResult.kind).toBe('rejected');
    if (approvalResult.kind === 'rejected') expect(approvalResult.error).toBeInstanceOf(ConflictException);
  });

  it('requires and encrypts the override reason when approving unresolved critical conflicts', async () => {
    await pool.query(
      `UPDATE public.extracted_facts SET review_status = 'conflict'
       WHERE tenant_id = $1 AND case_id = $2 AND field_name = 'annual_revenue'`, [tenantId, caseId],
    );
    const row = await pool.query<{ id: string }>(
      `SELECT id FROM public.memo_versions WHERE tenant_id = $1 AND case_id = $2`, [tenantId, caseId],
    );
    const memoId = row.rows[0]?.id;
    if (!memoId) throw new Error('Memo fixture was not generated.');
    await request(api.getHttpServer()).post(`/v1/memos/${memoId}/approve`).send({}).expect(409);
    const response = await request(api.getHttpServer()).post(`/v1/memos/${memoId}/approve`)
      .send({ override_reason: 'Conflicting financial evidence reviewed.' }).expect(200);
    expect(response.headers['cache-control']).toBe('no-store');

    const approved = await pool.query(
      `SELECT status, approval_override_ciphertext ? 'ciphertext' AS encrypted
       FROM public.memo_versions WHERE tenant_id = $1 AND id = $2`, [tenantId, memoId],
    );
    const audit = await pool.query("SELECT metadata FROM public.audit_events WHERE tenant_id = $1 AND event_type = 'memo.approved'", [tenantId]);
    expect(approved.rows).toEqual([{ status: 'approved', encrypted: true }]);
    expect(audit.rows[0]?.metadata).toMatchObject({ overrideUsed: true, overrideReasonHash: expect.any(String) });
  });
});

async function waitForApprovalLockOrSettlement(pool: Pool, isSettled: () => boolean): Promise<'waiting' | 'settled' | 'timeout'> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (isSettled()) return 'settled';
    const result = await pool.query(
      `SELECT 1 FROM pg_stat_activity
       WHERE pid <> pg_backend_pid() AND state = 'active' AND wait_event_type = 'Lock'
         AND query ILIKE '%FOR UPDATE%' AND query ILIKE '%extracted_facts%' LIMIT 1`,
    );
    if (result.rowCount) return 'waiting';
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return 'timeout';
}
