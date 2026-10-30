import type { TenantTransaction } from '../../infrastructure/database/tenant-transaction.js';

export interface AuditEvent {
  readonly type: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface AuditEventRepository {
  record(tenantId: string, actorId: string, event: AuditEvent, transaction: TenantTransaction): Promise<void>;
}
