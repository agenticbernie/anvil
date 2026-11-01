import 'reflect-metadata';

import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHmac, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { PinoLogger } from 'nestjs-pino';
import { PostgresUnitOfWork } from '../src/infrastructure/database/postgres-unit-of-work.js';
import { PostgresTenantMembershipRepository } from '../src/modules/auth/infrastructure/postgres-tenant-membership.repository.js';
import { PostgresEntityRepository } from '../src/modules/entities/infrastructure/postgres-entity.repository.js';
import { PostgresTenantMappingRepository } from '../src/modules/tenants/infrastructure/postgres-tenant-mapping.repository.js';
import { PostgresAuditEventRepository } from '../src/modules/audit/infrastructure/postgres-audit-event.repository.js';
import { ClerkWebhookService } from '../src/modules/webhooks/clerk/clerk-webhook.service.js';
import type { ClerkOrganizationMetadataService } from '../src/modules/webhooks/clerk/clerk-organization-metadata.service.js';

const tenantA = '00000000-0000-4000-8000-000000000001';
const tenantB = '00000000-0000-4000-8000-000000000002';
const adminAuthId = '00000000-0000-4000-8000-000000000011';
const viewerAuthId = '00000000-0000-4000-8000-000000000012';
const otherAuthId = '00000000-0000-4000-8000-000000000013';
const directAuthId = '00000000-0000-4000-8000-000000000014';
const adminAppId = '00000000-0000-4000-8000-000000000021';
const viewerAppId = '00000000-0000-4000-8000-000000000022';
const directAppId = '00000000-0000-4000-8000-000000000023';

describe('Tenant identity mapping and authorization', () => {
  let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
  let pool: Pool;
  let unitOfWork: PostgresUnitOfWork;
  let memberships: PostgresTenantMembershipRepository;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    await pool.query(`
      CREATE ROLE anon NOLOGIN;
      CREATE ROLE authenticated NOLOGIN;
      CREATE ROLE service_role NOLOGIN BYPASSRLS;
      CREATE SCHEMA auth;
      CREATE TABLE auth.users (id uuid PRIMARY KEY);
      CREATE TABLE auth.identities (user_id uuid NOT NULL REFERENCES auth.users(id), provider_id text NOT NULL, provider text NOT NULL);
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
        $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      GRANT USAGE ON SCHEMA auth TO authenticated, service_role;
      GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated, service_role;
    `);
    for (const migration of [
      '0001_init_schema.sql',
      '20261030120000_add_cases_and_idempotency.sql',
      '20261030220000_clerk_webhook_provisioning.sql',
      '20261030223000_clerk_identity_without_supabase_uuid.sql',
      '20261101120000_add_entities.sql',
      '20261101130000_align_clerk_tenant_roles.sql',
      '20261101140000_restrict_clerk_identity_lookup.sql',
    ]) {
      await pool.query(readFileSync(resolve(process.cwd(), 'supabase/migrations', migration), 'utf8'));
    }
    await pool.query('INSERT INTO auth.users (id) VALUES ($1), ($2), ($3), ($4)', [adminAuthId, viewerAuthId, otherAuthId, directAuthId]);
    await pool.query(
      `INSERT INTO auth.identities (user_id, provider_id, provider) VALUES
         ($1, 'user_admin', 'custom:clerk'), ($2, 'user_viewer', 'custom:clerk'), ($3, 'user_admin', 'github')`,
      [adminAuthId, viewerAuthId, otherAuthId],
    );
    await pool.query("INSERT INTO public.tenants (id, name, provisioned_by_clerk_organization_id) VALUES ($1, 'A', 'org_a'), ($2, 'B', 'org_b')", [tenantA, tenantB]);
    await pool.query(
      `INSERT INTO public.users (id, auth_user_id, clerk_user_id) VALUES
         ($1, NULL, 'user_admin'), ($2, NULL, 'user_viewer'), ($3, $4, NULL)`,
      [adminAppId, viewerAppId, directAppId, directAuthId],
    );
    await pool.query(
      `INSERT INTO public.memberships (tenant_id, user_id, role) VALUES
         ($1, $2, 'tenant_admin'), ($1, $3, 'viewer'), ($1, $4, 'originator')`,
      [tenantA, adminAppId, viewerAppId, directAppId],
    );
    unitOfWork = new PostgresUnitOfWork(pool);
    memberships = new PostgresTenantMembershipRepository(unitOfWork);
  }, 120000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  it('resolves the correct role for Clerk identities whose App IDs differ from Auth IDs', async () => {
    await expect(memberships.findActiveRole(tenantA, adminAuthId)).resolves.toBe('tenant_admin');
    await expect(memberships.findActiveRole(tenantA, viewerAuthId)).resolves.toBe('viewer');
    await expect(memberships.findActiveRole(tenantA, directAuthId)).resolves.toBe('originator');
  });

  it('denies cross-tenant access and identities from a different provider', async () => {
    await expect(memberships.findActiveRole(tenantB, adminAuthId)).resolves.toBeNull();
    await expect(memberships.findActiveRole(tenantA, otherAuthId)).resolves.toBeNull();
  });

  it('resolves an organization only for its active authenticated members', async () => {
    const mapping = new PostgresTenantMappingRepository(pool);
    await expect(mapping.findActiveTenantForClerkOrganization('org_a', adminAuthId)).resolves.toBe(tenantA);
    await expect(mapping.findActiveTenantForClerkOrganization('org_b', adminAuthId)).resolves.toBeNull();
    await expect(mapping.findActiveTenantForClerkOrganization('org_a', otherAuthId)).resolves.toBeNull();
  });

  it('restricts the Clerk identity lookup to the backend role', async () => {
    const result = await unitOfWork.run({ tenantId: tenantA, actorId: adminAuthId }, (transaction) =>
      transaction.withBackendRole((backend) => backend.query<{ id: string }>(
        'SELECT public.clerk_supabase_user_id($1)::text AS id', ['user_admin'],
      )));
    expect(result.rows[0]?.id).toBe(adminAuthId);
    await expect(unitOfWork.run({ tenantId: tenantA, actorId: adminAuthId }, (transaction) =>
      transaction.query('SELECT public.clerk_supabase_user_id($1)', ['user_admin']))).rejects.toThrow();
  });

  it('allows an authorized Clerk member to create an encrypted entity under RLS', async () => {
    const entityId = randomUUID();
    const result = await unitOfWork.run({ tenantId: tenantA, actorId: adminAuthId }, (transaction) =>
      new PostgresEntityRepository().create(tenantA, adminAuthId, entityInput(entityId), transaction));
    expect(result.id).toBe(entityId);
    expect(result.tenantId).toBe(tenantA);
    await unitOfWork.run({ tenantId: tenantA, actorId: adminAuthId }, (transaction) =>
      new PostgresAuditEventRepository().record(tenantA, adminAuthId, {
        type: 'entity.created', resourceType: 'entity', resourceId: entityId, metadata: {},
      }, transaction));
  });

  it('rejects a viewer and an actor ID that differs from the transaction identity', async () => {
    await expect(unitOfWork.run({ tenantId: tenantA, actorId: viewerAuthId }, (transaction) =>
      new PostgresEntityRepository().create(tenantA, viewerAuthId, entityInput(randomUUID()), transaction))).rejects.toThrow();
    await expect(unitOfWork.run({ tenantId: tenantA, actorId: adminAuthId }, (transaction) =>
      new PostgresEntityRepository().create(tenantA, viewerAuthId, entityInput(randomUUID()), transaction))).rejects.toThrow();
  });

  it('provisions a signed Clerk webhook and links the Supabase identity through the restricted lookup', async () => {
    const authId = randomUUID();
    await pool.query('INSERT INTO auth.users (id) VALUES ($1)', [authId]);
    await pool.query("INSERT INTO auth.identities (user_id, provider_id, provider) VALUES ($1, 'user_new', 'custom:clerk')", [authId]);
    const signingKey = Buffer.from('test-webhook-signing-key');
    const config = new ConfigService({ CLERK_WEBHOOK_SECRET: `whsec_${signingKey.toString('base64')}` });
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() } as unknown as PinoLogger;
    const metadata = { setTenantId: jest.fn() } as unknown as ClerkOrganizationMetadataService;
    const service = new ClerkWebhookService(pool, config, logger, metadata);
    const body = Buffer.from(JSON.stringify({ type: 'user.created', data: { id: 'user_new' } }));
    const id = 'evt_new_user';
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac('sha256', signingKey).update(`${id}.${timestamp}.${body.toString('utf8')}`).digest('base64');
    await service.handle(body, { id, timestamp, signature: `v1,${signature}` });
    const result = await pool.query<{ auth_user_id: string }>(
      "SELECT auth_user_id::text AS auth_user_id FROM public.users WHERE clerk_user_id = 'user_new'",
    );
    expect(result.rows[0]?.auth_user_id).toBe(authId);
  });
});

function entityInput(id: string) {
  return {
    id, tenantId: tenantA, entityType: 'business' as const, createdAt: new Date().toISOString(),
    ciphertext: Buffer.alloc(32), nonce: Buffer.alloc(12), keyVersion: 'v1', blindIndex: 'a'.repeat(64),
  };
}
