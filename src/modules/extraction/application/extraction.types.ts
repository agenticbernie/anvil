import type { TenantTransaction } from '../../../infrastructure/database/tenant-transaction.js';
import type { DocumentTextCipher, DocumentVersionSource, OutboxEventPayload, OutboxEventType } from '../../documents/application/document.types.js';

export interface ExtractionInput {
  readonly tenantId: string;
  readonly actorId: string;
  readonly caseId: string;
  readonly documentVersionId: string;
  readonly text: string;
}

/** Untrusted provider output. The application validates `facts` before persistence. */
export interface ExtractionResult {
  readonly facts: unknown;
  readonly modelName: string;
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  readonly costEstimate: number | null;
}

export interface LlmExtractionProvider {
  extract(input: ExtractionInput): Promise<ExtractionResult>;
}

export interface ExtractionJobPayload {
  readonly tenantId: string;
  readonly actorId: string;
  readonly caseId: string;
  readonly documentId: string;
  readonly documentVersionId: string;
  readonly processingJobId: string;
}

export interface ExtractionRun {
  readonly id: string;
  readonly tenantId: string;
  readonly caseId: string;
  readonly documentVersionId: string;
  readonly modelName: string;
  readonly promptHash: string;
  readonly status: 'processing' | 'retry_wait' | 'succeeded' | 'failed_validation' | 'failed';
  readonly attemptCount: number;
  readonly lockExpiresAt: string | null;
}

export interface ExtractedFact {
  readonly id: string;
  readonly tenantId: string;
  readonly extractionRunId: string;
  readonly caseId: string;
  readonly fieldName: string;
  readonly rawValue: unknown;
  readonly normalizedValue: unknown;
  readonly sourcePage: number;
  readonly confidence: number;
  readonly reviewStatus: 'unverified' | 'verified' | 'needs_evidence' | 'conflict' | 'rejected';
  readonly isCritical: boolean;
}

export interface FactUpdateUsage {
  readonly actorHourlyUpdates: number;
  readonly tenantHourlyUpdates: number;
  readonly tenantLifetimeUpdates: number;
}

export interface ExtractionRepository {
  findDocumentVersion(tenantId: string, actorId: string, documentVersionId: string, transaction: TenantTransaction): Promise<DocumentVersionSource | null>;
  beginRun(tenantId: string, actorId: string, input: { caseId: string; documentVersionId: string; modelName: string; promptHash: string }, transaction: TenantTransaction): Promise<{ readonly run: ExtractionRun; readonly acquired: boolean }>;
  insertFacts(tenantId: string, actorId: string, runId: string, caseId: string, facts: readonly { fieldName: string; rawValue: unknown; normalizedValue: unknown; sourcePage: number; confidence: number }[], transaction: TenantTransaction): Promise<readonly ExtractedFact[]>;
  markRunSucceeded(tenantId: string, actorId: string, runId: string, costEstimate: number | null, transaction: TenantTransaction): Promise<void>;
  markRunFailedValidation(tenantId: string, actorId: string, runId: string, validationError: string, transaction: TenantTransaction): Promise<void>;
  markRunRetryWait(tenantId: string, actorId: string, runId: string, transaction: TenantTransaction): Promise<void>;
  lockAndGetFactUpdateUsage(tenantId: string, actorId: string, transaction: TenantTransaction): Promise<FactUpdateUsage>;
  getFact(tenantId: string, actorId: string, factId: string, transaction: TenantTransaction): Promise<ExtractedFact | null>;
  updateFact(tenantId: string, actorId: string, factId: string, input: { normalizedValue?: unknown; reviewStatus?: ExtractedFact['reviewStatus']; isCritical?: boolean }, transaction: TenantTransaction): Promise<ExtractedFact>;
  listFactsForCase(tenantId: string, actorId: string, caseId: string, transaction: TenantTransaction, reviewStatus?: ExtractedFact['reviewStatus']): Promise<readonly ExtractedFact[]>;
  lockCriticalFactsForCase(tenantId: string, actorId: string, caseId: string, transaction: TenantTransaction): Promise<void>;
  countUnresolvedCriticalConflicts(tenantId: string, actorId: string, caseId: string, transaction: TenantTransaction): Promise<number>;
}

export interface OutboxWriter {
  create(tenantId: string, actorId: string, eventType: OutboxEventType, payload: OutboxEventPayload, transaction: TenantTransaction): Promise<void>;
}

export interface FactValueCipher {
  encrypt(tenantId: string, factId: string, field: string, value: unknown): Readonly<Record<string, unknown>>;
  decrypt(tenantId: string, factId: string, field: string, value: unknown): unknown;
  fingerprint(tenantId: string, resourceId: string, purpose: string, value: unknown): string;
}
