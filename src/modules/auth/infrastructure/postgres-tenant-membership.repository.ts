import { Inject, Injectable } from '@nestjs/common';
import type { UnitOfWork } from '../../../infrastructure/database/tenant-transaction.js';
import { UNIT_OF_WORK } from '../../../infrastructure/database/postgres.tokens.js';
import type { TenantRole } from '../../cases/application/case.types.js';
import type { TenantMembershipRepository } from '../tenant.types.js';

const VALID_ROLES = new Set<TenantRole>(['tenant_admin', 'originator', 'analyst', 'reviewer', 'auditor', 'viewer']);

@Injectable()
export class PostgresTenantMembershipRepository implements TenantMembershipRepository {
  constructor(@Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork) {}

  async findActiveRole(tenantId: string, actorId: string): Promise<TenantRole | null> {
    return this.unitOfWork.run({ tenantId, actorId }, async (transaction) => {
      const result = await transaction.query<{ role: string }>(
        `SELECT membership.role
         FROM public.memberships AS membership
         JOIN public.users AS app_user ON app_user.id = membership.user_id
         WHERE membership.tenant_id = $1
           AND $2::uuid = (SELECT auth.uid())
           AND public.is_tenant_member($1)
           AND membership.status = 'active' AND membership.deleted_at IS NULL
           AND app_user.status = 'active' AND app_user.deleted_at IS NULL
         LIMIT 1`,
        [tenantId, actorId],
      );
      const role = result.rows[0]?.role;
      return role && VALID_ROLES.has(role as TenantRole) ? role as TenantRole : null;
    });
  }
}
