import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { assertSupportedLlmProvider } from '../../config/llm-provider.guard.js';
import { UNIT_OF_WORK } from '../../infrastructure/database/postgres.tokens.js';
import type { UnitOfWork } from '../../infrastructure/database/tenant-transaction.js';
import { AuditModule } from '../audit/audit.module.js';
import { AUDIT_EVENT_REPOSITORY } from '../audit/audit.tokens.js';
import type { AuditEventRepository } from '../audit/audit.types.js';
import { AuthModule } from '../auth/auth.module.js';
import { DatabaseModule } from '../../infrastructure/database/database.module.js';
import { DocumentsModule } from '../documents/documents.module.js';
import { DOCUMENT_TEXT_CIPHER, OUTBOX_REPOSITORY } from '../documents/documents.tokens.js';
import type { DocumentTextCipher, OutboxRepository } from '../documents/application/document.types.js';
import { DocumentTextCipherService } from '../documents/infrastructure/document-text-cipher.service.js';
import { EXTRACTION_REPOSITORY, FACT_VALUE_CIPHER, LLM_EXTRACTION_PROVIDER } from './extraction.tokens.js';
import { ExtractionService } from './application/extraction.service.js';
import { OpenAiExtractionProvider } from './infrastructure/openai-extraction.provider.js';
import { TenantJsonEncryptionService } from './infrastructure/tenant-json-encryption.service.js';
import { PostgresExtractionRepository } from './infrastructure/postgres-extraction.repository.js';
import type { LlmExtractionProvider } from './application/extraction.types.js';
import { FactsController } from './api/facts.controller.js';

@Module({
  imports: [DatabaseModule, DocumentsModule, AuditModule, AuthModule],
  controllers: [FactsController],
  providers: [
    TenantJsonEncryptionService,
    { provide: FACT_VALUE_CIPHER, useExisting: TenantJsonEncryptionService },
    { provide: EXTRACTION_REPOSITORY, inject: [FACT_VALUE_CIPHER], useFactory: (cipher: import('./application/extraction.types.js').FactValueCipher) => new PostgresExtractionRepository(cipher) },
    {
      provide: LLM_EXTRACTION_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService): LlmExtractionProvider => {
        assertSupportedLlmProvider(config.get<string>('llm.provider', 'openai'));
        return new OpenAiExtractionProvider({
          apiKey: config.get<string>('llm.apiKey', ''), model: config.get<string>('llm.model', 'unconfigured-openai-model') || 'unconfigured-openai-model',
          timeoutMs: config.get<number>('llm.requestTimeoutMs', 30_000),
        });
      },
    },
    {
      provide: ExtractionService,
      inject: [EXTRACTION_REPOSITORY, LLM_EXTRACTION_PROVIDER, FACT_VALUE_CIPHER, DOCUMENT_TEXT_CIPHER, AUDIT_EVENT_REPOSITORY, OUTBOX_REPOSITORY, UNIT_OF_WORK, ConfigService],
      useFactory: (repository: PostgresExtractionRepository, provider: LlmExtractionProvider, factCipher: import('./application/extraction.types.js').FactValueCipher, textCipher: DocumentTextCipher,
        audit: AuditEventRepository, outbox: OutboxRepository, unitOfWork: UnitOfWork, config: ConfigService) =>
        new ExtractionService(repository, provider, factCipher, textCipher, audit, outbox, unitOfWork, config.get<string>('llm.model', 'unconfigured-openai-model') || 'unconfigured-openai-model'),
    },
  ],
  exports: [ExtractionService, EXTRACTION_REPOSITORY, LLM_EXTRACTION_PROVIDER, FACT_VALUE_CIPHER, TenantJsonEncryptionService],
})
export class ExtractionModule {}
