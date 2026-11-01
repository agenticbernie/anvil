import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from '../../../infrastructure/database/postgres.tokens.js';
import type { TenantMappingRepository } from '../tenant-mapping.types.js';

@Injectable()
export class PostgresTenantMappingRepository implements TenantMappingRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async findActiveTenantForClerkOrganization(organizationId: string, actorId: string): Promise<string | null> {
    const client = await this.pool.connect();
    let transactionStarted = false;
    try {
      await client.query('BEGIN');
      transactionStarted = true;
      await client.query("SET LOCAL statement_timeout = '5s'");
      const result = await client.query<{ tenant_id: string }>(
        `SELECT tenant.id::text AS tenant_id
         FROM public.tenants AS tenant
         JOIN public.memberships AS membership ON membership.tenant_id = tenant.id
         JOIN public.users AS app_user ON app_user.id = membership.user_id
         JOIN auth.identities AS identity ON identity.user_id = $2::uuid
           AND identity.provider_id = app_user.clerk_user_id
           AND identity.provider IN ('custom:clerk', 'clerk')
         WHERE tenant.provisioned_by_clerk_organization_id = $1
           AND tenant.status = 'active' AND tenant.deleted_at IS NULL
           AND membership.status = 'active' AND membership.deleted_at IS NULL
           AND app_user.status = 'active' AND app_user.deleted_at IS NULL
         LIMIT 1`,
        [organizationId, actorId],
      );
      await client.query('COMMIT');
      transactionStarted = false;
      return result.rows[0]?.tenant_id ?? null;
    } catch (error) {
      if (transactionStarted) {
        try { await client.query('ROLLBACK'); }
        catch (rollbackError) { throw new AggregateError([error, rollbackError], 'Tenant mapping query and rollback both failed.'); }
      }
      throw error;
    } finally {
      client.release();
    }
  }
}
