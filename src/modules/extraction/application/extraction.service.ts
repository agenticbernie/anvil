import { createHash } from 'node:crypto';
import { BadRequestException, ConflictException, HttpException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import type { AuditEventRepository } from '../../audit/audit.types.js';
import type { UnitOfWork } from '../../../infrastructure/database/tenant-transaction.js';
import { ExtractionResultSchema } from './extraction.schema.js';
import type { DocumentTextCipher } from '../../documents/application/document.types.js';
import type { ExtractedFact, ExtractionJobPayload, ExtractionRepository, FactValueCipher, LlmExtractionProvider, OutboxWriter } from './extraction.types.js';

const PROMPT_VERSION = 'credit-extraction-v1';
const CRITICAL_FIELDS = new Set(['annual_revenue', 'ebitda', 'debt', 'cash_balance', 'requested_amount', 'loan_amount']);

export const FACT_UPDATE_LIMITS = Object.freeze({ actorPerHour: 10, tenantPerHour: 100, tenantLifetime: 100_000 });

export interface ExtractionProcessResult {
  readonly status: 'succeeded' | 'already_processed' | 'already_processing' | 'failed_validation';
  readonly factCount: number;
  readonly extractionRunId?: string;
}

@Injectable()
export class ExtractionService {
  constructor(
    private readonly repository: ExtractionRepository,
    private readonly provider: LlmExtractionProvider,
    private readonly factCipher: FactValueCipher,
    private readonly textCipher: DocumentTextCipher,
    private readonly audit: AuditEventRepository,
    private readonly outbox: OutboxWriter,
    private readonly unitOfWork: UnitOfWork,
    private readonly modelName: string,
  ) {
    if (!modelName.trim()) throw new Error('Extraction model name is required.');
  }

  async process(payload: ExtractionJobPayload): Promise<ExtractionProcessResult> {
    const promptHash = createHash('sha256').update(PROMPT_VERSION).digest('hex');
    const scope = { tenantId: payload.tenantId, actorId: payload.actorId };
    const claim = await this.unitOfWork.run(scope, async (transaction) => {
      const document = await this.repository.findDocumentVersion(payload.tenantId, payload.actorId, payload.documentVersionId, transaction);
      if (!document || document.caseId !== payload.caseId || document.documentId !== payload.documentId) {
        throw new NotFoundException('Document version was not found in this tenant and case.');
      }
      const result = await this.repository.beginRun(payload.tenantId, payload.actorId, {
        caseId: payload.caseId, documentVersionId: payload.documentVersionId, modelName: this.modelName, promptHash,
      }, transaction);
      return { document, ...result };
    });

    if (!claim.acquired) {
      const done = claim.run.status === 'succeeded' || claim.run.status === 'failed_validation' || claim.run.status === 'failed';
      return { status: done ? 'already_processed' : 'already_processing', factCount: 0, extractionRunId: claim.run.id };
    }

    try {
      const text = this.textCipher.decrypt(
        payload.tenantId, payload.documentVersionId,
        claim.document.sourceTextCiphertext, claim.document.sourceTextNonce, claim.document.sourceTextKeyVersion,
      );
      const result = await this.provider.extract({
        tenantId: payload.tenantId, actorId: payload.actorId, caseId: payload.caseId,
        documentVersionId: payload.documentVersionId, text,
      });
      const parsed = ExtractionResultSchema.safeParse({ facts: result.facts });
      if (!parsed.success || parsed.data.facts.some((fact) => fact.source_page > claim.document.sourcePageCount)) {
        const error = parsed.success ? 'source_page exceeds document page count' : parsed.error.issues.map((issue) => `${issue.path.join('.')}:${issue.code}`).join(', ').slice(0, 500);
        return await this.unitOfWork.run(scope, async (transaction) => {
          await this.repository.markRunFailedValidation(payload.tenantId, payload.actorId, claim.run.id, error, transaction);
          await this.outbox.create(payload.tenantId, payload.actorId, 'extraction.needs_manual_review', {
            caseId: payload.caseId, documentId: payload.documentId, extractionRunId: claim.run.id,
          }, transaction);
          await this.audit.record(payload.tenantId, payload.actorId, {
            type: 'extraction.failed_validation', resourceType: 'extraction_run', resourceId: claim.run.id,
            metadata: { documentVersionId: payload.documentVersionId, issueCount: parsed.success ? 1 : parsed.error.issues.length },
          }, transaction);
          return { status: 'failed_validation' as const, factCount: 0, extractionRunId: claim.run.id };
        });
      }

      return await this.unitOfWork.run(scope, async (transaction) => {
        const facts = await this.repository.insertFacts(
          payload.tenantId, payload.actorId, claim.run.id, payload.caseId,
          parsed.data.facts.map((fact) => ({
            fieldName: fact.field_name, rawValue: fact.raw_value, normalizedValue: fact.normalized_value,
            sourcePage: fact.source_page, confidence: fact.confidence,
          })), transaction,
        );
        const costEstimate = typeof result.costEstimate === 'number' && Number.isFinite(result.costEstimate) && result.costEstimate >= 0
          ? result.costEstimate : null;
        await this.repository.markRunSucceeded(payload.tenantId, payload.actorId, claim.run.id, costEstimate, transaction);
        for (const fact of facts) {
          await this.audit.record(payload.tenantId, payload.actorId, {
            type: 'fact.created', resourceType: 'extracted_fact', resourceId: fact.id,
            metadata: { extractionRunId: claim.run.id, fieldName: fact.fieldName, sourcePage: fact.sourcePage, confidence: fact.confidence, reviewStatus: 'unverified' },
          }, transaction);
        }
        return { status: 'succeeded' as const, factCount: facts.length, extractionRunId: claim.run.id };
      });
    } catch (error) {
      try {
        await this.unitOfWork.run(scope, (transaction) => this.repository.markRunRetryWait(payload.tenantId, payload.actorId, claim.run.id, transaction));
      } catch (stateError) {
        throw new AggregateError([error, stateError], 'Extraction failed and retry state could not be persisted.');
      }
      throw error;
    }
  }

  async updateFact(tenantId: string, actorId: string, factId: string, input: { normalizedValue?: unknown; reviewStatus?: ExtractedFact['reviewStatus']; isCritical?: boolean }) {
    if (input.normalizedValue === undefined && input.reviewStatus === undefined && input.isCritical === undefined) {
      throw new BadRequestException('At least one fact field must be supplied.');
    }
    return this.unitOfWork.run({ tenantId, actorId }, async (transaction) => {
      const usage = await this.repository.lockAndGetFactUpdateUsage(tenantId, actorId, transaction);
      if (usage.tenantLifetimeUpdates >= FACT_UPDATE_LIMITS.tenantLifetime) {
        throw new ConflictException('Tenant fact review update limit reached.');
      }
      if (usage.actorHourlyUpdates >= FACT_UPDATE_LIMITS.actorPerHour
        || usage.tenantHourlyUpdates >= FACT_UPDATE_LIMITS.tenantPerHour) {
        throw new HttpException('Fact review update hourly budget is exhausted.', HttpStatus.TOO_MANY_REQUESTS);
      }
      const before = await this.repository.getFact(tenantId, actorId, factId, transaction);
      if (!before) throw new NotFoundException('Fact not found in this tenant.');
      const after = await this.repository.updateFact(tenantId, actorId, factId, input, transaction);
      const verified = before.reviewStatus !== 'verified' && after.reviewStatus === 'verified';
      await this.audit.record(tenantId, actorId, {
        type: verified ? 'fact.verified' : 'fact.updated', resourceType: 'extracted_fact', resourceId: factId,
        metadata: {
          fields: Object.keys(input),
          beforeHash: this.factCipher.fingerprint(tenantId, factId, 'fact-review', { value: before.normalizedValue, status: before.reviewStatus, isCritical: before.isCritical }),
          afterHash: this.factCipher.fingerprint(tenantId, factId, 'fact-review', { value: after.normalizedValue, status: after.reviewStatus, isCritical: after.isCritical }),
          reviewStatus: after.reviewStatus,
        },
      }, transaction);
      return after;
    });
  }

  async listFactsForCase(
    tenantId: string,
    actorId: string,
    caseId: string,
    reviewStatus?: ExtractedFact['reviewStatus'],
  ): Promise<readonly ExtractedFact[]> {
    return this.unitOfWork.run({ tenantId, actorId }, (transaction) =>
      this.repository.listFactsForCase(tenantId, actorId, caseId, transaction, reviewStatus));
  }
}
