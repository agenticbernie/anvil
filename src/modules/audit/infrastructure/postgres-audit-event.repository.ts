import { ForbiddenException } from '@nestjs/common';
import type { TenantTransaction } from '../../../infrastructure/database/tenant-transaction.js';
import type { AuditEvent, AuditEventRepository } from '../audit.types.js';

export class PostgresAuditEventRepository implements AuditEventRepository {
  async record(tenantId: string, actorId: string, event: AuditEvent, transaction: TenantTransaction): Promise<void> {
    await transaction.withBackendRole(async (backendTransaction) => {
      const result = await backendTransaction.query(
        `INSERT INTO public.audit_events (tenant_id, actor_id, event_type, resource_type, resource_id, metadata)
         SELECT $1, $2, $3, $4, $5, $6::jsonb WHERE $2::uuid = (SELECT auth.uid())`,
        [tenantId, actorId, event.type, event.resourceType, event.resourceId, JSON.stringify(event.metadata)],
      );
      if (result.rowCount !== 1) throw new ForbiddenException('Actor does not match the authenticated database principal.');
    });
  }
}
