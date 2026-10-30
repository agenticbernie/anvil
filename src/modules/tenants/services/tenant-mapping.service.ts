import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { TENANT_MAPPING_REPOSITORY } from '../tenant-mapping.types.js';
import type { TenantMappingRepository } from '../tenant-mapping.types.js';

@Injectable()
export class TenantMappingService {
  constructor(@Inject(TENANT_MAPPING_REPOSITORY) private readonly tenants: TenantMappingRepository) {}

  async findByClerkOrganization(organizationId: string, actorId: string): Promise<{ tenant_id: string }> {
    const tenantId = await this.tenants.findActiveTenantForClerkOrganization(organizationId, actorId);
    if (!tenantId) throw new NotFoundException('Tenant for this Clerk organization is not provisioned or accessible yet.');
    return { tenant_id: tenantId };
  }
}
