import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UNIT_OF_WORK, PG_POOL } from '../../infrastructure/database/postgres.tokens.js';
import type { Pool } from 'pg';
import type { UnitOfWork } from '../../infrastructure/database/tenant-transaction.js';
import { DatabaseModule } from '../../infrastructure/database/database.module.js';
import { StorageModule } from '../../infrastructure/storage/storage.module.js';
import { AUDIT_EVENT_REPOSITORY } from '../audit/audit.tokens.js';
import type { AuditEventRepository } from '../audit/audit.types.js';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { CasesModule } from '../cases/cases.module.js';
import { CASE_REPOSITORY } from '../cases/cases.tokens.js';
import type { CaseRepository } from '../cases/application/case.types.js';
import { CaseDocumentsController, DocumentsController } from './api/documents.controller.js';
import { DocumentService } from './application/document.service.js';
import { JobsController } from '../jobs/api/jobs.controller.js';
import { ProcessingJobStatusService } from '../jobs/application/processing-job-status.service.js';
import { DOCUMENT_REPOSITORY, DOCUMENT_RESERVATION_MAINTENANCE_REPOSITORY, DOCUMENT_TEXT_CIPHER, DOCUMENT_VERSION_REPOSITORY, OUTBOX_REPOSITORY, PROCESSING_JOB_REPOSITORY, STORAGE_PROVIDER } from './documents.tokens.js';
import { PostgresDocumentRepository } from './infrastructure/postgres-document.repository.js';
import { PostgresDocumentReservationMaintenanceRepository } from './infrastructure/postgres-document-reservation-maintenance.repository.js';
import { PostgresOutboxRepository } from './infrastructure/postgres-outbox.repository.js';
import { PostgresProcessingJobRepository } from './infrastructure/postgres-processing-job.repository.js';
import { DocumentEncryptionService } from './infrastructure/document-encryption.service.js';
import { DocumentTextCipherService } from './infrastructure/document-text-cipher.service.js';
import { PostgresDocumentVersionRepository } from './infrastructure/postgres-document-version.repository.js';

@Module({
  imports: [DatabaseModule, AuthModule, CasesModule, AuditModule, StorageModule],
  controllers: [CaseDocumentsController, DocumentsController, JobsController],
  providers: [
    { provide: DOCUMENT_REPOSITORY, useClass: PostgresDocumentRepository },
    {
      provide: DOCUMENT_RESERVATION_MAINTENANCE_REPOSITORY,
      inject: [PG_POOL],
      useFactory: (pool: Pool) => new PostgresDocumentReservationMaintenanceRepository(pool),
    },
    { provide: PROCESSING_JOB_REPOSITORY, useClass: PostgresProcessingJobRepository },
    {
      provide: ProcessingJobStatusService,
      inject: [PROCESSING_JOB_REPOSITORY, UNIT_OF_WORK],
      useFactory: (jobs: PostgresProcessingJobRepository, unitOfWork: UnitOfWork) => new ProcessingJobStatusService(jobs, unitOfWork),
    },
    DocumentEncryptionService,
    DocumentTextCipherService,
    { provide: DOCUMENT_TEXT_CIPHER, useExisting: DocumentTextCipherService },
    { provide: DOCUMENT_VERSION_REPOSITORY, useClass: PostgresDocumentVersionRepository },
    {
      provide: OUTBOX_REPOSITORY,
      inject: [PG_POOL],
      useFactory: (pool: Pool) => new PostgresOutboxRepository(pool),
    },
    {
      provide: DocumentService,
      inject: [DOCUMENT_REPOSITORY, PROCESSING_JOB_REPOSITORY, OUTBOX_REPOSITORY, CASE_REPOSITORY, STORAGE_PROVIDER, AUDIT_EVENT_REPOSITORY, UNIT_OF_WORK, DocumentEncryptionService, ConfigService],
      useFactory: (
        documents: PostgresDocumentRepository,
        jobs: PostgresProcessingJobRepository,
        outbox: PostgresOutboxRepository,
        cases: CaseRepository,
        storage: import('./application/document.types.js').StorageProvider,
        audit: AuditEventRepository,
        unitOfWork: UnitOfWork,
        encryption: DocumentEncryptionService,
        config: ConfigService,
      ) => new DocumentService(
        documents, jobs, outbox, cases, storage, audit, unitOfWork, encryption,
        config.get<number>('MAX_UPLOAD_BYTES', 52_428_800),
      ),
    },
  ],
  exports: [DocumentService, DocumentEncryptionService, DocumentTextCipherService, DOCUMENT_TEXT_CIPHER, DOCUMENT_VERSION_REPOSITORY, DOCUMENT_REPOSITORY, DOCUMENT_RESERVATION_MAINTENANCE_REPOSITORY, PROCESSING_JOB_REPOSITORY, OUTBOX_REPOSITORY, StorageModule],
})
export class DocumentsModule {}
