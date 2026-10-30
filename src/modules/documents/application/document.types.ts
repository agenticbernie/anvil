import type { TenantTransaction, UnitOfWork } from '../../../infrastructure/database/tenant-transaction.js';

export const ALLOWED_DOCUMENT_CONTENT_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
] as const;
export type DocumentContentType = (typeof ALLOWED_DOCUMENT_CONTENT_TYPES)[number];
export type DocumentStatus = 'pending_upload' | 'uploaded' | 'processing' | 'processed' | 'rejected' | 'failed';
export type ProcessingJobStatus = 'queued' | 'processing' | 'retry_wait' | 'succeeded' | 'failed' | 'dead_lettered';
export type DocumentProcessingErrorCode = 'DOCUMENT_CHECKSUM_MISMATCH' | 'DOCUMENT_ENCRYPTION_FAILED' | 'DOCUMENT_PARSE_FAILED';

export interface DocumentRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly caseId: string;
  readonly uploadedBy: string;
  /** Client-writable staging key. Never used by the parser. */
  readonly objectKey: string;
  /** Server-only finalized object key, set atomically with the uploaded state. */
  readonly finalObjectKey: string | null;
  readonly contentType: DocumentContentType;
  readonly sizeBytes: number;
  readonly storageSizeBytes: number;
  readonly sha256: string;
  readonly wrappedDataKey: string | null;
  readonly encryptionNonce: string | null;
  readonly encryptionKeyVersion: string | null;
  readonly status: DocumentStatus;
}

export interface DocumentListItem {
  readonly id: string;
  readonly caseId: string;
  readonly contentType: DocumentContentType;
  readonly sizeBytes: number;
  readonly status: DocumentStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateDocumentRecord {
  readonly id: string;
  readonly caseId: string;
  readonly objectKey: string;
  readonly contentType: DocumentContentType;
  readonly sizeBytes: number;
  readonly storageSizeBytes: number;
  readonly sha256: string;
  readonly wrappedDataKey: string;
  readonly encryptionNonce: string;
  readonly encryptionKeyVersion: string;
}

export interface DocumentEncryptionMaterial {
  readonly uploadKeyBase64: string;
  readonly nonceBase64: string;
  readonly additionalDataBase64: string;
  readonly wrappedDataKey: string;
  readonly keyVersion: string;
}

export interface DocumentEncryptionContext {
  readonly tenantId: string;
  readonly documentId: string;
  readonly wrappedDataKey: string;
  readonly nonceBase64: string;
  readonly keyVersion: string;
  readonly additionalDataBase64: string;
}

export interface DocumentEncryptionProvider {
  createUploadMaterial(tenantId: string, documentId: string): DocumentEncryptionMaterial;
  decryptStream(context: DocumentEncryptionContext, source: AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array>;
}

export interface ProcessingJobRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly caseId: string;
  readonly documentId: string;
  readonly actorId: string;
  readonly status: ProcessingJobStatus;
  readonly attemptCount: number;
}

export interface ProcessingJobStatusRecord {
  readonly id: string;
  readonly caseId: string;
  readonly documentId: string;
  readonly status: ProcessingJobStatus;
  readonly progress: number;
  readonly errorCode: DocumentProcessingErrorCode | null;
  readonly attemptCount: number;
  readonly updatedAt: string;
}

export interface BeginJobAttempt {
  readonly acquired: boolean;
  readonly completed: boolean;
  readonly attemptCount: number;
}

export interface DocumentRepository {
  create(tenantId: string, actorId: string, input: CreateDocumentRecord, transaction: TenantTransaction): Promise<DocumentRecord>;
  findById(tenantId: string, actorId: string, documentId: string, transaction: TenantTransaction): Promise<DocumentRecord | null>;
  listByCase(tenantId: string, actorId: string, caseId: string, transaction: TenantTransaction): Promise<readonly DocumentListItem[]>;
  reserveFinalObjectKey(tenantId: string, actorId: string, documentId: string, candidateKey: string, transaction: TenantTransaction): Promise<string>;
  markUploaded(tenantId: string, actorId: string, documentId: string, finalObjectKey: string, transaction: TenantTransaction): Promise<boolean>;
  markProcessing(tenantId: string, actorId: string, documentId: string, transaction: TenantTransaction): Promise<void>;
  markProcessed(tenantId: string, actorId: string, documentId: string, transaction: TenantTransaction): Promise<void>;
  markFailed(tenantId: string, actorId: string, documentId: string, rejected: boolean, transaction: TenantTransaction): Promise<void>;
}

export interface ProcessingJobRepository {
  create(tenantId: string, actorId: string, caseId: string, documentId: string, transaction: TenantTransaction): Promise<ProcessingJobRecord>;
  findForDocument(tenantId: string, actorId: string, documentId: string, transaction: TenantTransaction): Promise<ProcessingJobRecord | null>;
  findById(tenantId: string, actorId: string, jobId: string, transaction: TenantTransaction): Promise<ProcessingJobStatusRecord | null>;
  beginAttempt(tenantId: string, actorId: string, jobId: string, documentId: string, caseId: string, transaction: TenantTransaction): Promise<BeginJobAttempt>;
  markRetryWait(tenantId: string, actorId: string, jobId: string, code: DocumentProcessingErrorCode, transaction: TenantTransaction): Promise<void>;
  markSucceeded(tenantId: string, actorId: string, jobId: string, workerVersion: string, transaction: TenantTransaction): Promise<void>;
  markDeadLettered(tenantId: string, actorId: string, jobId: string, code: DocumentProcessingErrorCode, transaction: TenantTransaction): Promise<void>;
}

export interface StorageHead {
  readonly contentLength: number;
  readonly contentType: string | undefined;
  readonly sha256Metadata: string | undefined;
  readonly eTag: string | undefined;
}

export interface PresignedUpload {
  readonly uploadUrl: string;
  readonly requiredHeaders: Readonly<Record<string, string>>;
  readonly expiresAt: string;
}

export interface StorageProvider {
  presignPut(objectKey: string, contentType: string, sha256: string, contentLengthBytes: number, expiresInSeconds: number): Promise<PresignedUpload>;
  headObject(objectKey: string): Promise<StorageHead | null>;
  finalizeUpload(stagingKey: string, finalKey: string, expectedETag: string): Promise<void>;
  deleteObject(objectKey: string): Promise<void>;
  getObjectStream(objectKey: string): Promise<AsyncIterable<Uint8Array>>;
}

export interface StagingCleanupCandidate {
  readonly tenantId: string;
  readonly documentId: string;
  readonly stagingObjectKey: string;
  readonly finalizedObjectKey?: string;
}

/** Global lease is intentionally restricted to the service-role maintenance worker. */
export interface DocumentReservationMaintenanceRepository {
  claimExpiredReservations(limit: number): Promise<readonly StagingCleanupCandidate[]>;
  markExpiredReservationCleanupChecked(tenantId: string, documentId: string): Promise<boolean>;
  claimStagingCleanupRetries(limit: number): Promise<readonly StagingCleanupCandidate[]>;
  markStagingCleanupChecked(tenantId: string, documentId: string): Promise<boolean>;
  purgeOldRateLimitWindows(): Promise<void>;
}

export type OutboxEventType = 'document.uploaded' | 'document.parse.dead_lettered' | 'document.extract.requested' | 'extraction.needs_manual_review' | 'memo.generate.requested';
export interface OutboxEventPayload {
  readonly caseId: string;
  readonly processingJobId?: string;
  readonly documentId?: string;
  readonly documentVersionId?: string;
  readonly extractionRunId?: string;
  readonly generationKey?: string;
  readonly overrideReasonCiphertext?: Readonly<Record<string, unknown>>;
}

export interface OutboxEvent {
  readonly id: string;
  readonly tenantId: string;
  readonly actorId: string;
  readonly eventType: OutboxEventType;
  readonly payload: OutboxEventPayload;
  readonly publishAttempts: number;
}

export interface OutboxRepository {
  create(tenantId: string, actorId: string, eventType: OutboxEventType, payload: OutboxEventPayload, transaction: TenantTransaction): Promise<void>;
  claimPending(limit: number): Promise<readonly OutboxEvent[]>;
  markPublished(tenantId: string, actorId: string, eventId: string, transaction: TenantTransaction): Promise<void>;
  retryOrDeadLetter(tenantId: string, actorId: string, event: OutboxEvent, errorMessage: string, transaction: TenantTransaction): Promise<void>;
}

export interface DocumentTextCipher {
  encrypt(tenantId: string, documentVersionId: string, plaintext: string): {
    readonly ciphertext: Uint8Array; readonly nonce: Uint8Array; readonly keyVersion: string;
  };
  decrypt(tenantId: string, documentVersionId: string, ciphertext: Uint8Array, nonce: Uint8Array, keyVersion: string): string;
}

export interface DocumentVersionSource {
  readonly id: string; readonly tenantId: string; readonly caseId: string; readonly documentId: string;
  readonly sourceTextCiphertext: Uint8Array; readonly sourceTextNonce: Uint8Array;
  readonly sourceTextKeyVersion: string; readonly sourcePageCount: number;
}

export interface DocumentVersionRepository {
  create(tenantId: string, actorId: string, input: {
    readonly id: string; readonly caseId: string; readonly documentId: string;
    readonly sourceTextCiphertext: Uint8Array; readonly sourceTextNonce: Uint8Array;
    readonly sourceTextKeyVersion: string; readonly sourcePageCount: number; readonly sourceTextHash: string;
  }, transaction: TenantTransaction): Promise<void>;
}

export interface DocumentProcessingPayload extends OutboxEventPayload {
  readonly processingJobId: string;
  readonly documentId: string;
  readonly tenantId: string;
  readonly actorId: string;
}

export type DocumentUnitOfWork = UnitOfWork;
