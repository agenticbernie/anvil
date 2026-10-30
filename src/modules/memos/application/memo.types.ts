import type { TenantTransaction } from '../../../infrastructure/database/tenant-transaction.js';
import type { ExtractedFact } from '../../extraction/application/extraction.types.js';
import type { CreditMemoContent } from './memo.schema.js';

export interface MemoGenerationInput {
  readonly tenantId: string;
  readonly actorId: string;
  readonly caseId: string;
  readonly facts: readonly ExtractedFact[];
}

export interface LlmMemoProvider {
  generate(input: MemoGenerationInput): Promise<unknown>;
}

export type MemoStatus = 'generating' | 'draft' | 'approved' | 'rejected' | 'failed';
export interface MemoVersion {
  readonly id: string;
  readonly tenantId: string;
  readonly caseId: string;
  readonly versionNumber: number;
  readonly inputHash: string;
  readonly status: MemoStatus;
  readonly content: CreditMemoContent | null;
  readonly approvedAt: string | null;
  readonly rejectedAt: string | null;
  readonly rejectionReason: string | null;
}

export interface MemoGenerationPayload {
  readonly tenantId: string;
  readonly actorId: string;
  readonly caseId: string;
  readonly generationKey: string;
}

export interface MemoRepository {
  claimGeneration(tenantId: string, actorId: string, caseId: string, inputHash: string, tx: TenantTransaction): Promise<{ readonly memoId: string; readonly versionNumber: number; readonly acquired: boolean }>;
  markDraft(tenantId: string, actorId: string, memoId: string, encryptedContent: unknown, tx: TenantTransaction): Promise<void>;
  markFailed(tenantId: string, actorId: string, memoId: string, tx: TenantTransaction): Promise<void>;
  getById(tenantId: string, actorId: string, memoId: string, tx: TenantTransaction): Promise<MemoVersion | null>;
  listByCase(tenantId: string, actorId: string, caseId: string, tx: TenantTransaction): Promise<readonly MemoVersion[]>;
  approve(tenantId: string, actorId: string, memoId: string, encryptedOverrideReason: unknown | null, tx: TenantTransaction): Promise<MemoVersion>;
  reject(tenantId: string, actorId: string, memoId: string, encryptedReason: unknown, tx: TenantTransaction): Promise<MemoVersion>;
}

export interface MemoContentCipher {
  encrypt(tenantId: string, memoId: string, field: 'content' | 'override_reason' | 'rejection_reason', value: unknown): Readonly<Record<string, unknown>>;
  decrypt(tenantId: string, memoId: string, field: 'content' | 'override_reason' | 'rejection_reason', value: unknown): unknown;
  fingerprint(tenantId: string, resourceId: string, purpose: string, value: unknown): string;
}

export interface MemoQueueWriter {
  create(tenantId: string, actorId: string, eventType: 'memo.generate.requested', payload: {
    caseId: string;
    generationKey: string;
    overrideReasonCiphertext?: Readonly<Record<string, unknown>>;
  }, tx: TenantTransaction): Promise<void>;
}

export interface MemoRequestResult { readonly accepted: true; readonly jobId: string; }
