import { Module } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CasesController } from '../modules/cases/api/cases.controller.js';
import { CaseService } from '../modules/cases/application/case.service.js';
import { EntitiesController } from '../modules/entities/api/entities.controller.js';
import { EntityService } from '../modules/entities/application/entity.service.js';
import { CaseDocumentsController, DocumentsController } from '../modules/documents/api/documents.controller.js';
import { DocumentService } from '../modules/documents/application/document.service.js';
import { ExtractionService } from '../modules/extraction/application/extraction.service.js';
import { FactsController } from '../modules/extraction/api/facts.controller.js';
import { HealthController } from '../modules/health/controllers/health.controller.js';
import { IdempotencyService } from '../modules/idempotency/application/idempotency.service.js';
import { IdempotencyInterceptor } from '../modules/idempotency/idempotency.interceptor.js';
import { MemosController } from '../modules/memos/api/memos.controller.js';
import { MemoService } from '../modules/memos/application/memo.service.js';
import { JobsController } from '../modules/jobs/api/jobs.controller.js';
import { ProcessingJobStatusService } from '../modules/jobs/application/processing-job-status.service.js';
import { TENANT_MEMBERSHIP_REPOSITORY } from '../modules/auth/auth.tokens.js';
import { RolesGuard } from '../modules/auth/roles.guard.js';
import { SupabaseAuthGuard } from '../modules/auth/supabase-auth.guard.js';
import { TenantContextGuard } from '../modules/auth/tenant-context.guard.js';
import { ClerkTenantMappingController } from '../modules/tenants/api/clerk-tenant-mapping.controller.js';
import { TenantMappingService } from '../modules/tenants/services/tenant-mapping.service.js';

@Module({
  controllers: [CasesController, EntitiesController, CaseDocumentsController, DocumentsController, FactsController, MemosController, JobsController, HealthController, ClerkTenantMappingController],
  providers: [
    { provide: CaseService, useValue: {} },
    { provide: EntityService, useValue: {} },
    { provide: DocumentService, useValue: {} },
    { provide: ExtractionService, useValue: {} },
    { provide: MemoService, useValue: {} },
    { provide: ProcessingJobStatusService, useValue: {} },
    { provide: TenantMappingService, useValue: {} },
    { provide: TENANT_MEMBERSHIP_REPOSITORY, useValue: { findActiveRole: async () => null } },
    SupabaseAuthGuard,
    TenantContextGuard,
    { provide: Reflector, useFactory: () => new Reflector() },
    RolesGuard,
    { provide: IdempotencyService, useValue: {} },
    {
      provide: IdempotencyInterceptor,
      inject: [IdempotencyService],
      useFactory: (service: IdempotencyService) => new IdempotencyInterceptor(service),
    },
  ],
})
export class OpenApiModule {}
