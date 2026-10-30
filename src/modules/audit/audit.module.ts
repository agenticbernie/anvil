import { Module } from '@nestjs/common';
import { AUDIT_EVENT_REPOSITORY } from './audit.tokens.js';
import { PostgresAuditEventRepository } from './infrastructure/postgres-audit-event.repository.js';

@Module({
  providers: [PostgresAuditEventRepository, { provide: AUDIT_EVENT_REPOSITORY, useExisting: PostgresAuditEventRepository }],
  exports: [AUDIT_EVENT_REPOSITORY],
})
export class AuditModule {}
