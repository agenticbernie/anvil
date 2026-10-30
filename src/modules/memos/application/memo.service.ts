import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { UnitOfWork } from '../../../infrastructure/database/tenant-transaction.js';
import type { AuditEventRepository } from '../../audit/audit.types.js';
import type { CaseRepository } from '../../cases/application/case.types.js';
import type { ExtractionRepository } from '../../extraction/application/extraction.types.js';
import { CreditMemoSchema } from './memo.schema.js';
import type { LlmMemoProvider, MemoContentCipher, MemoGenerationPayload, MemoQueueWriter, MemoRepository } from './memo.types.js';

@Injectable()
export class MemoService {
  constructor(
    private readonly memos: MemoRepository,
    private readonly provider: LlmMemoProvider,
    private readonly valueCipher: MemoContentCipher,
    private readonly facts: ExtractionRepository,
    private readonly cases: CaseRepository,
    private readonly outbox: MemoQueueWriter,
    private readonly audit: AuditEventRepository,
    private readonly unitOfWork: UnitOfWork,
  ) {}

  async requestGeneration(tenantId: string, actorId: string, caseId: string, overrideReason?: string): Promise<{ accepted: true; jobId: string }> {
    const normalizedReason = overrideReason?.trim();
    if (overrideReason !== undefined && (!normalizedReason || normalizedReason.length > 1_000)) {
      throw new BadRequestException('override_reason must contain 1 to 1000 characters.');
    }
    const generationKey = randomUUID();
    await this.unitOfWork.run({ tenantId, actorId }, async (tx) => {
      if (!await this.cases.findById(tenantId, actorId, caseId, tx)) throw new NotFoundException('Credit case not found in this tenant.');
      await this.facts.lockCriticalFactsForCase(tenantId, actorId, caseId, tx);
      const conflictCount = await this.facts.countUnresolvedCriticalConflicts(tenantId, actorId, caseId, tx);
      if (conflictCount > 0 && !normalizedReason) {
        throw new ConflictException({ message: 'Unresolved critical conflicts require override_reason.', conflictCount });
      }
      const overrideReasonCiphertext = normalizedReason
        ? this.valueCipher.encrypt(tenantId, generationKey, 'override_reason', normalizedReason)
        : undefined;
      await this.outbox.create(tenantId, actorId, 'memo.generate.requested', {
        caseId, generationKey, ...(overrideReasonCiphertext ? { overrideReasonCiphertext } : {}),
      }, tx);
      await this.audit.record(tenantId, actorId, {
        type: 'memo.generation_requested', resourceType: 'credit_case', resourceId: caseId,
        metadata: {
          generationKey,
          criticalConflictCount: conflictCount,
          overrideUsed: Boolean(normalizedReason),
          overrideReasonHash: normalizedReason ? this.valueCipher.fingerprint(tenantId, generationKey, 'memo-override', normalizedReason) : null,
        },
      }, tx);
    });
    return { accepted: true, jobId: generationKey };
  }

  async generate(payload: MemoGenerationPayload): Promise<{ status: 'draft' | 'already_exists'; memoId?: string }> {
    const prepared = await this.unitOfWork.run({ tenantId: payload.tenantId, actorId: payload.actorId }, async (tx) => {
      const facts = await this.facts.listFactsForCase(payload.tenantId, payload.actorId, payload.caseId, tx);
      const inputSnapshot = facts.map((fact) => ({
        id: fact.id, fieldName: fact.fieldName, rawValue: fact.rawValue, normalizedValue: fact.normalizedValue,
        sourcePage: fact.sourcePage, confidence: fact.confidence, reviewStatus: fact.reviewStatus, isCritical: fact.isCritical,
      }));
      const inputHash = this.valueCipher.fingerprint(payload.tenantId, payload.caseId, 'memo-input', stableJson(inputSnapshot));
      const claim = await this.memos.claimGeneration(payload.tenantId, payload.actorId, payload.caseId, inputHash, tx);
      return { facts, inputHash, claim };
    });
    if (!prepared.claim.acquired) return { status: 'already_exists', memoId: prepared.claim.memoId };

    try {
      const candidate = await this.provider.generate({
        tenantId: payload.tenantId, actorId: payload.actorId, caseId: payload.caseId, facts: prepared.facts,
      });
      const parsed = CreditMemoSchema.safeParse(candidate);
      const knownFacts = new Map(prepared.facts.map((fact) => [fact.id, fact.fieldName]));
      const provenanceInvalid = parsed.success && parsed.data.financial_highlights.some((item) =>
        item.source_fact_ids.some((factId) => knownFacts.get(factId) !== item.field_name));
      if (!parsed.success || provenanceInvalid) throw new MemoValidationError('Memo output failed schema or fact provenance validation.');
      const encrypted = this.valueCipher.encrypt(payload.tenantId, prepared.claim.memoId, 'content', parsed.data);
      await this.unitOfWork.run({ tenantId: payload.tenantId, actorId: payload.actorId }, async (tx) => {
        await this.memos.markDraft(payload.tenantId, payload.actorId, prepared.claim.memoId, encrypted, tx);
        await this.audit.record(payload.tenantId, payload.actorId, {
          type: 'memo.generated', resourceType: 'memo_version', resourceId: prepared.claim.memoId,
          metadata: { caseId: payload.caseId, versionNumber: prepared.claim.versionNumber, inputHash: prepared.inputHash },
        }, tx);
      });
      return { status: 'draft' as const, memoId: prepared.claim.memoId };
    } catch (error) {
      try {
        await this.unitOfWork.run({ tenantId: payload.tenantId, actorId: payload.actorId }, async (tx) => {
          await this.memos.markFailed(payload.tenantId, payload.actorId, prepared.claim.memoId, tx);
          await this.audit.record(payload.tenantId, payload.actorId, {
            type: error instanceof MemoValidationError ? 'memo.failed_validation' : 'memo.generation_failed',
            resourceType: 'memo_version', resourceId: prepared.claim.memoId,
            metadata: { caseId: payload.caseId, errorCode: error instanceof MemoValidationError ? 'INVALID_OUTPUT' : 'PROVIDER_FAILURE' },
          }, tx);
        });
      } catch (stateError) {
        throw new AggregateError([error, stateError], 'Memo generation failed and failure state could not be persisted.');
      }
      throw error;
    }
  }

  async approve(tenantId: string, actorId: string, memoId: string, overrideReason?: string) {
    const normalizedReason = overrideReason?.trim();
    if (overrideReason !== undefined && (!normalizedReason || normalizedReason.length > 1_000)) {
      throw new BadRequestException('override_reason must contain 1 to 1000 characters.');
    }
    return this.unitOfWork.run({ tenantId, actorId }, async (tx) => {
      const memo = await this.memos.getById(tenantId, actorId, memoId, tx);
      if (!memo) throw new NotFoundException('Memo not found in this tenant.');
      if (memo.status !== 'draft') throw new ConflictException('Only draft memos can be approved.');
      await this.facts.lockCriticalFactsForCase(tenantId, actorId, memo.caseId, tx);
      const conflictCount = await this.facts.countUnresolvedCriticalConflicts(tenantId, actorId, memo.caseId, tx);
      if (conflictCount > 0 && !normalizedReason) {
        throw new ConflictException({ message: 'Unresolved critical conflicts require override_reason.', conflictCount });
      }
      const encryptedReason = normalizedReason
        ? this.valueCipher.encrypt(tenantId, memoId, 'override_reason', normalizedReason)
        : null;
      const approved = await this.memos.approve(tenantId, actorId, memoId, encryptedReason, tx);
      await this.audit.record(tenantId, actorId, {
        type: 'memo.approved', resourceType: 'memo_version', resourceId: memoId,
        metadata: {
          caseId: memo.caseId, overrideUsed: Boolean(normalizedReason),
          overrideReasonHash: normalizedReason ? this.valueCipher.fingerprint(tenantId, memoId, 'memo-override', normalizedReason) : null,
        },
      }, tx);
      return approved;
    });
  }

  async reject(tenantId: string, actorId: string, memoId: string, reason: string) {
    const normalizedReason = reason.trim();
    if (!normalizedReason || normalizedReason.length > 1_000) {
      throw new BadRequestException('reason must contain 1 to 1000 characters.');
    }
    return this.unitOfWork.run({ tenantId, actorId }, async (tx) => {
      const memo = await this.memos.getById(tenantId, actorId, memoId, tx);
      if (!memo) throw new NotFoundException('Memo not found in this tenant.');
      if (memo.status !== 'draft') throw new ConflictException('Only draft memos can be rejected.');
      const encryptedReason = this.valueCipher.encrypt(tenantId, memoId, 'rejection_reason', normalizedReason);
      const rejected = await this.memos.reject(tenantId, actorId, memoId, encryptedReason, tx);
      await this.audit.record(tenantId, actorId, {
        type: 'memo.rejected', resourceType: 'memo_version', resourceId: memoId,
        metadata: {
          caseId: memo.caseId,
          reasonHash: this.valueCipher.fingerprint(tenantId, memoId, 'memo-rejection', normalizedReason),
        },
      }, tx);
      return rejected;
    });
  }

  async get(tenantId: string, actorId: string, memoId: string) {
    const memo = await this.unitOfWork.run({ tenantId, actorId }, (tx) => this.memos.getById(tenantId, actorId, memoId, tx));
    if (!memo) throw new NotFoundException('Memo not found in this tenant.');
    return memo;
  }

  async listForCase(tenantId: string, actorId: string, caseId: string) {
    return this.unitOfWork.run({ tenantId, actorId }, async (tx) => {
      const creditCase = await this.cases.findById(tenantId, actorId, caseId, tx);
      if (!creditCase || creditCase.deletedAt !== null || creditCase.status === 'archived') {
        throw new NotFoundException('Active credit case not found.');
      }
      return this.memos.listByCase(tenantId, actorId, caseId, tx);
    });
  }
}

export class MemoValidationError extends Error { constructor(message: string) { super(message); this.name = 'MemoValidationError'; } }

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
