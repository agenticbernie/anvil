import 'reflect-metadata';

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { PostgresUnitOfWork } from '../src/infrastructure/database/postgres-unit-of-work.js';
import { PostgresTenantMembershipRepository } from '../src/modules/auth/infrastructure/postgres-tenant-membership.repository.js';
import { PostgresEntityRepository } from '../src/modules/entities/infrastructure/postgres-entity.repository.js';

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
    ]) {
      await pool.query(readFileSync(resolve(process.cwd(), 'supabase/migrations', migration), 'utf8'));
    }
    await pool.query('INSERT INTO auth.users (id) VALUES ($1), ($2), ($3), ($4)', [adminAuthId, viewerAuthId, otherAuthId, directAuthId]);
    await pool.query(
      `INSERT INTO auth.identities (user_id, provider_id, provider) VALUES
         ($1, 'user_admin', 'custom:clerk'), ($2, 'user_viewer', 'custom:clerk'), ($3, 'user_admin', 'github')`,
      [adminAuthId, viewerAuthId, otherAuthId],
    );
    await pool.query("INSERT INTO public.tenants (id, name) VALUES ($1, 'A'), ($2, 'B')", [tenantA, tenantB]);
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

  it('allows an authorized Clerk member to create an encrypted entity under RLS', async () => {
    const entityId = randomUUID();
    const result = await unitOfWork.run({ tenantId: tenantA, actorId: adminAuthId }, (transaction) =>
      new PostgresEntityRepository().create(tenantA, adminAuthId, entityInput(entityId), transaction));
    expect(result.id).toBe(entityId);
    expect(result.tenantId).toBe(tenantA);
  });

  it('rejects a viewer and an actor ID that differs from the transaction identity', async () => {
    await expect(unitOfWork.run({ tenantId: tenantA, actorId: viewerAuthId }, (transaction) =>
      new PostgresEntityRepository().create(tenantA, viewerAuthId, entityInput(randomUUID()), transaction))).rejects.toThrow();
    await expect(unitOfWork.run({ tenantId: tenantA, actorId: adminAuthId }, (transaction) =>
      new PostgresEntityRepository().create(tenantA, viewerAuthId, entityInput(randomUUID()), transaction))).rejects.toThrow();
  });
});

function entityInput(id: string) {
  return {
    id, tenantId: tenantA, entityType: 'business' as const, createdAt: new Date().toISOString(),
    ciphertext: Buffer.alloc(32), nonce: Buffer.alloc(12), keyVersion: 'v1', blindIndex: 'a'.repeat(64),
  };
}
