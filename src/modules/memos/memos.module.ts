import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { assertSupportedLlmProvider } from '../../config/llm-provider.guard.js';
import { UNIT_OF_WORK } from '../../infrastructure/database/postgres.tokens.js';
import type { UnitOfWork } from '../../infrastructure/database/tenant-transaction.js';
import { DatabaseModule } from '../../infrastructure/database/database.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { AUDIT_EVENT_REPOSITORY } from '../audit/audit.tokens.js';
import type { AuditEventRepository } from '../audit/audit.types.js';
import { AuthModule } from '../auth/auth.module.js';
import { IdempotencyModule } from '../idempotency/idempotency.module.js';
import { CasesModule } from '../cases/cases.module.js';
import { CASE_REPOSITORY } from '../cases/cases.tokens.js';
import type { CaseRepository } from '../cases/application/case.types.js';
import { DocumentsModule } from '../documents/documents.module.js';
import { OUTBOX_REPOSITORY } from '../documents/documents.tokens.js';
import type { OutboxRepository } from '../documents/application/document.types.js';
import { ExtractionModule } from '../extraction/extraction.module.js';
import { EXTRACTION_REPOSITORY } from '../extraction/extraction.tokens.js';
import type { ExtractionRepository } from '../extraction/application/extraction.types.js';
import { TenantJsonEncryptionService } from '../extraction/infrastructure/tenant-json-encryption.service.js';
import { LLM_MEMO_PROVIDER, MEMO_CONTENT_CIPHER, MEMO_REPOSITORY } from './memo.tokens.js';
import { MemosController } from './api/memos.controller.js';
import { MemoService } from './application/memo.service.js';
import type { LlmMemoProvider, MemoContentCipher, MemoRepository } from './application/memo.types.js';
import { FakeMemoProvider } from './infrastructure/fake-memo.provider.js';
import { OpenAiMemoProvider } from './infrastructure/openai-memo.provider.js';
import { PostgresMemoRepository } from './infrastructure/postgres-memo.repository.js';

@Module({
  imports: [DatabaseModule, AuthModule, AuditModule, CasesModule, DocumentsModule, ExtractionModule, IdempotencyModule],
  controllers: [MemosController],
  providers: [
    { provide: MEMO_CONTENT_CIPHER, useExisting: TenantJsonEncryptionService },
    {
      provide: MEMO_REPOSITORY,
      inject: [MEMO_CONTENT_CIPHER],
      useFactory: (cipher: MemoContentCipher): MemoRepository => new PostgresMemoRepository(cipher),
    },
    {
      provide: LLM_MEMO_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService): LlmMemoProvider => {
        assertSupportedLlmProvider(config.get<string>('llm.provider', 'openai'));
        return new OpenAiMemoProvider({
          apiKey: config.get<string>('llm.apiKey', ''), model: config.get<string>('llm.model', 'unconfigured-openai-model') || 'unconfigured-openai-model',
          timeoutMs: config.get<number>('llm.requestTimeoutMs', 30_000),
        });
      },
    },
    {
      provide: MemoService,
      inject: [MEMO_REPOSITORY, LLM_MEMO_PROVIDER, MEMO_CONTENT_CIPHER, EXTRACTION_REPOSITORY, CASE_REPOSITORY, OUTBOX_REPOSITORY, AUDIT_EVENT_REPOSITORY, UNIT_OF_WORK],
      useFactory: (memos: MemoRepository, provider: LlmMemoProvider, cipher: MemoContentCipher, facts: ExtractionRepository,
        cases: CaseRepository, outbox: OutboxRepository, audit: AuditEventRepository, unitOfWork: UnitOfWork) =>
        new MemoService(memos, provider, cipher, facts, cases, outbox, audit, unitOfWork),
    },
  ],
  exports: [MemoService, MEMO_REPOSITORY, LLM_MEMO_PROVIDER],
})
export class MemosModule {}
