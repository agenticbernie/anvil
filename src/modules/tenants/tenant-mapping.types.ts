export interface TenantMappingRepository {
  findActiveTenantForClerkOrganization(organizationId: string, actorId: string): Promise<string | null>;
}

export const TENANT_MAPPING_REPOSITORY = Symbol('TENANT_MAPPING_REPOSITORY');
