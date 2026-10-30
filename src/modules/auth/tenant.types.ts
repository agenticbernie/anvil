import type { TenantRole } from '../cases/application/case.types.js';

export interface AuthenticatedUser {
  readonly id: string;
  readonly appMetadata: Readonly<Record<string, unknown>>;
}

export interface TenantContext {
  readonly tenantId: string;
  readonly actorId: string;
  readonly role: TenantRole;
}

export interface TenantMembershipRepository {
  findActiveRole(tenantId: string, actorId: string): Promise<TenantRole | null>;
}
