import { describe, expect, it, jest } from '@jest/globals';
import { createCipheriv } from 'node:crypto';
import { UnrecoverableError, type ConnectionOptions } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import type { TenantTransaction, UnitOfWork } from '../infrastructure/database/tenant-transaction.js';
import type { DocumentProcessingPayload, DocumentRecord, DocumentRepository, OutboxRepository, ProcessingJobRepository, StorageProvider } from '../modules/documents/application/document.types.js';
import { DocumentEncryptionService } from '../modules/documents/infrastructure/document-encryption.service.js';
import { DocumentParseWorker } from './document-parse.worker.js';

const tenantId = '00000000-0000-4000-8000-000000000001';
const actorId = '00000000-0000-4000-8000-000000000011';
const caseId = '00000000-0000-4000-8000-000000000021';
const documentId = '00000000-0000-4000-8000-000000000031';
const jobId = '00000000-0000-4000-8000-000000000041';
const transaction = {} as TenantTransaction;
const payload: DocumentProcessingPayload = { tenantId, actorId, caseId, documentId, processingJobId: jobId };
const encryption = new DocumentEncryptionService(new ConfigService({
  PII_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 9).toString('base64'), PII_ENCRYPTION_KEY_VERSION: 'v1',
}));
const encryptionMaterial = encryption.createUploadMaterial(tenantId, documentId);
const document: DocumentRecord = {
  id: documentId, tenantId, caseId, uploadedBy: actorId, objectKey: `tenant/${tenantId}/staging/${documentId}`,
  finalObjectKey: `tenant/${tenantId}/finalized/${documentId}`,
  contentType: 'application/pdf', sizeBytes: 7, storageSizeBytes: 23, sha256: 'a'.repeat(64),
  wrappedDataKey: encryptionMaterial.wrappedDataKey, encryptionNonce: encryptionMaterial.nonceBase64,
  encryptionKeyVersion: encryptionMaterial.keyVersion, status: 'uploaded',
};

describe('DocumentParseWorker idempotency and terminal failures', () => {
  it('does not read R2 or repeat side effects for an already completed job', async () => {
    const jobs = { beginAttempt: jest.fn(async () => ({ acquired: false, completed: true, attemptCount: 1 })) } as unknown as ProcessingJobRepository;
    const documents = { findById: jest.fn(async () => document) } as unknown as DocumentRepository;
    const storage = { getObjectStream: jest.fn(async () => { throw new Error('must not be called'); }) } as unknown as StorageProvider;
    const worker = createWorker(documents, jobs, { create: jest.fn() } as unknown as OutboxRepository, storage);

    await worker.processJob(payload);

    expect(jobs.beginAttempt).toHaveBeenCalledWith(tenantId, actorId, jobId, documentId, caseId, transaction);
    expect(storage.getObjectStream).not.toHaveBeenCalled();
  });

  it('rejects a checksum mismatch and records terminal job state plus a durable DLQ outbox event', async () => {
    const jobs = {
      beginAttempt: jest.fn(async () => ({ acquired: true, completed: false, attemptCount: 1 })),
      markDeadLettered: jest.fn(async () => undefined),
      markRetryWait: jest.fn(async () => undefined),
    } as unknown as ProcessingJobRepository;
    const documents = {
      findById: jest.fn(async () => document), markProcessing: jest.fn(async () => undefined),
      markFailed: jest.fn(async () => undefined),
    } as unknown as DocumentRepository;
    const outbox = { create: jest.fn(async () => undefined) } as unknown as OutboxRepository;
    const wrongBytes = Buffer.from('wrong!!');
    const cipher = createCipheriv('aes-256-gcm', Buffer.from(encryptionMaterial.uploadKeyBase64, 'base64'), Buffer.from(encryptionMaterial.nonceBase64, 'base64'));
    cipher.setAAD(Buffer.from(encryptionMaterial.additionalDataBase64, 'base64'));
    const encryptedBytes = Buffer.concat([cipher.update(wrongBytes), cipher.final(), cipher.getAuthTag()]);
    const storage = { getObjectStream: jest.fn(async () => [encryptedBytes]) } as unknown as StorageProvider;
    const worker = createWorker(documents, jobs, outbox, storage);

    await expect(worker.processJob(payload)).rejects.toBeInstanceOf(UnrecoverableError);

    expect(jobs.markDeadLettered).toHaveBeenCalledWith(
      tenantId, actorId, jobId, 'DOCUMENT_CHECKSUM_MISMATCH', transaction,
    );
    expect(jobs.markRetryWait).not.toHaveBeenCalled();
    expect(documents.markFailed).toHaveBeenCalledWith(tenantId, actorId, documentId, true, transaction);
    expect(outbox.create).toHaveBeenCalledWith(tenantId, actorId, 'document.parse.dead_lettered', {
      processingJobId: jobId, documentId, caseId,
    }, transaction);
  });

  it('persists and rethrows a fixed error when R2 returns a sensitive provider message', async () => {
    const secretDiagnostic = 'R2 authorization failed for account=borrower-tax-id-12345';
    const jobs = {
      beginAttempt: jest.fn(async () => ({ acquired: true, completed: false, attemptCount: 1 })),
      markRetryWait: jest.fn(async () => undefined),
      markDeadLettered: jest.fn(async () => undefined),
    } as unknown as ProcessingJobRepository;
    const documents = {
      findById: jest.fn(async () => document), markProcessing: jest.fn(async () => undefined),
    } as unknown as DocumentRepository;
    const storage = {
      getObjectStream: jest.fn(async () => { throw new Error(secretDiagnostic); }),
    } as unknown as StorageProvider;
    const worker = createWorker(documents, jobs, { create: jest.fn() } as unknown as OutboxRepository, storage);

    await expect(worker.processJob(payload)).rejects.toThrow('Document processing failed.');

    expect(jobs.markRetryWait).toHaveBeenCalledWith(tenantId, actorId, jobId, 'DOCUMENT_PARSE_FAILED', transaction);
    expect(jobs.markRetryWait.mock.calls.flat().join(' ')).not.toContain(secretDiagnostic);
    expect(jobs.markDeadLettered).not.toHaveBeenCalled();
  });
});

function createWorker(
  documents: DocumentRepository,
  jobs: ProcessingJobRepository,
  outbox: OutboxRepository,
  storage: StorageProvider,
): DocumentParseWorker {
  const unitOfWork = {
    run: jest.fn(async (_scope: unknown, work: (tx: TenantTransaction) => Promise<unknown>) => work(transaction)),
  } as unknown as UnitOfWork;
  return new DocumentParseWorker(
    documents, jobs, outbox, storage, encryption, unitOfWork,
    { create: jest.fn(async () => undefined) } as never,
    { encrypt: jest.fn(() => ({ ciphertext: Buffer.from('cipher'), nonce: Buffer.alloc(12), keyVersion: 'v1' })) } as never,
    {} as ConnectionOptions, { get: () => 1 } as never,
  );
}
