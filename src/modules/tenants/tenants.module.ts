import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ClerkTenantMappingController } from './api/clerk-tenant-mapping.controller.js';
import { PostgresTenantMappingRepository } from './infrastructure/postgres-tenant-mapping.repository.js';
import { TenantMappingService } from './services/tenant-mapping.service.js';
import { TENANT_MAPPING_REPOSITORY } from './tenant-mapping.types.js';

@Module({
  imports: [AuthModule],
  controllers: [ClerkTenantMappingController],
  providers: [
    PostgresTenantMappingRepository,
    { provide: TENANT_MAPPING_REPOSITORY, useExisting: PostgresTenantMappingRepository },
    TenantMappingService,
  ],
})
export class TenantsModule {}
