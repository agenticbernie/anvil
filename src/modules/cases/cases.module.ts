import { Module } from '@nestjs/common';
import { UNIT_OF_WORK } from '../../infrastructure/database/postgres.tokens.js';
import type { UnitOfWork } from '../../infrastructure/database/tenant-transaction.js';
import { AUDIT_EVENT_REPOSITORY } from '../audit/audit.tokens.js';
import type { AuditEventRepository } from '../audit/audit.types.js';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { IdempotencyModule } from '../idempotency/idempotency.module.js';
import { CaseService } from './application/case.service.js';
import { CasesController } from './api/cases.controller.js';
import { CASE_REPOSITORY } from './cases.tokens.js';
import { PostgresCaseRepository } from './infrastructure/postgres-case.repository.js';

@Module({
  imports: [AuthModule, AuditModule, IdempotencyModule],
  controllers: [CasesController],
  providers: [
    { provide: CASE_REPOSITORY, useClass: PostgresCaseRepository },
    {
      provide: CaseService,
      inject: [CASE_REPOSITORY, AUDIT_EVENT_REPOSITORY, UNIT_OF_WORK],
      useFactory: (cases: PostgresCaseRepository, audit: AuditEventRepository, unitOfWork: UnitOfWork) =>
        new CaseService(cases, audit, unitOfWork),
    },
  ],
  exports: [CASE_REPOSITORY],
})
export class CasesModule {}
