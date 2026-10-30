import { describe, expect, it, jest } from '@jest/globals';
import type { TenantTransaction, UnitOfWork } from '../../../infrastructure/database/tenant-transaction.js';
import type { AuditEventRepository } from '../../audit/audit.types.js';
import type { CaseRepository } from '../../cases/application/case.types.js';
import { DocumentService } from './document.service.js';
import type { DocumentRecord, DocumentRepository, OutboxRepository, ProcessingJobRecord, ProcessingJobRepository, StorageProvider } from './document.types.js';

const tenantId = '00000000-0000-4000-8000-000000000001';
const actorId = '00000000-0000-4000-8000-000000000011';
const documentId = '00000000-0000-4000-8000-000000000012';
const caseId = '00000000-0000-4000-8000-000000000021';
const digest = 'a'.repeat(64);
const transaction = {} as TenantTransaction;

function createFixture() {
  const document: DocumentRecord = {
    id: documentId, tenantId, caseId, uploadedBy: actorId, objectKey: `tenants/${tenantId}/documents/staging/${documentId}`, finalObjectKey: null,
    contentType: 'application/pdf', sizeBytes: 120, storageSizeBytes: 136, sha256: digest,
    wrappedDataKey: 'v1.wrap.cipher', encryptionNonce: 'nonce-base64', encryptionKeyVersion: 'v1', status: 'pending_upload',
  };
  const job: ProcessingJobRecord = {
    id: '00000000-0000-4000-8000-000000000051', tenantId, caseId, documentId, actorId, status: 'queued', attemptCount: 0,
  };
  const documents = {
    create: jest.fn(async () => document), findById: jest.fn(async () => document), markUploaded: jest.fn(async () => true),
    reserveFinalObjectKey: jest.fn(async (_tenantId: string, _actorId: string, _documentId: string, candidateKey: string) => candidateKey),
  } as unknown as DocumentRepository;
  const jobs = { create: jest.fn(async () => job), findForDocument: jest.fn(async () => null) } as unknown as ProcessingJobRepository;
  const outbox = { create: jest.fn(async () => undefined) } as unknown as OutboxRepository;
  const storage = {
    presignPut: jest.fn(async (_key: string, _type: string, _hash: string, _length: number) => ({
      uploadUrl: 'https://r2.test.invalid/upload',
      requiredHeaders: { 'content-length': '136', 'content-type': 'application/pdf' },
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
    })),
    headObject: jest.fn(async () => ({ contentLength: 136, contentType: 'application/pdf', sha256Metadata: digest, eTag: '"staging-etag"' })),
    finalizeUpload: jest.fn(async () => undefined), deleteObject: jest.fn(async () => undefined),
  } as unknown as StorageProvider;
  const audit = { record: jest.fn(async () => undefined) } as unknown as AuditEventRepository;
  const unitOfWork = {
    run: jest.fn(async (_scope: unknown, work: (tx: TenantTransaction) => Promise<unknown>) => work(transaction)),
  } as unknown as UnitOfWork;
  const encryption = {
    createUploadMaterial: jest.fn(() => ({
      uploadKeyBase64: Buffer.alloc(32, 7).toString('base64'), nonceBase64: Buffer.alloc(12, 8).toString('base64'),
      additionalDataBase64: Buffer.from('aad').toString('base64'), wrappedDataKey: 'v1.wrap.cipher', keyVersion: 'v1',
    })),
  };
  const cases = { findById: jest.fn(async () => ({ id: caseId, deletedAt: null, status: 'draft' })) } as unknown as CaseRepository;
  const service = new DocumentService(documents, jobs, outbox, cases, storage, audit, unitOfWork, encryption);
  return { service, documents, jobs, outbox, storage, audit, unitOfWork, job, encryption };
}

describe('DocumentService.confirmUpload', () => {
  it('creates processing job and outbox event in the same transaction after R2 metadata validation', async () => {
    const fixture = createFixture();

    const result = await fixture.service.confirmUpload(tenantId, actorId, documentId, { sha256: digest });

    expect(result).toEqual({ jobId: fixture.job.id, status: 'queued' });
    expect(fixture.unitOfWork.run).toHaveBeenCalledTimes(3);
    expect(fixture.storage.finalizeUpload).toHaveBeenCalledWith(
      expect.stringContaining('/staging/'), expect.stringContaining('/finalized/'), '"staging-etag"',
    );
    expect(fixture.documents.markUploaded).toHaveBeenCalledWith(
      tenantId, actorId, documentId, expect.stringContaining('/finalized/'), transaction,
    );
    expect(fixture.documents.reserveFinalObjectKey).toHaveBeenCalledWith(
      tenantId, actorId, documentId, expect.stringContaining('/finalized/'), transaction,
    );
    expect(fixture.jobs.create).toHaveBeenCalledWith(tenantId, actorId, caseId, documentId, transaction);
    expect(fixture.outbox.create).toHaveBeenCalledWith(
      tenantId, actorId, 'document.uploaded', { processingJobId: fixture.job.id, documentId, caseId }, transaction,
    );
    expect(fixture.audit.record).toHaveBeenCalledWith(
      tenantId, actorId, expect.objectContaining({ type: 'document.upload.confirmed', resourceId: documentId }), transaction,
    );
  });

  it('rejects a confirm digest that differs from the digest bound to the presigned upload', async () => {
    const fixture = createFixture();

    await expect(fixture.service.confirmUpload(tenantId, actorId, documentId, { sha256: 'b'.repeat(64) }))
      .rejects.toMatchObject({ status: 422 });

    expect(fixture.storage.headObject).not.toHaveBeenCalled();
    expect(fixture.outbox.create).not.toHaveBeenCalled();
  });

  it('does not create work when the R2 object metadata does not match the declaration', async () => {
    const fixture = createFixture();
    (fixture.storage.headObject as jest.MockedFunction<StorageProvider['headObject']>).mockResolvedValue({
      contentLength: 121, contentType: 'application/pdf', sha256Metadata: digest, eTag: '"staging-etag"',
    });

    await expect(fixture.service.confirmUpload(tenantId, actorId, documentId, { sha256: digest }))
      .rejects.toMatchObject({ status: 422 });

    expect(fixture.jobs.create).not.toHaveBeenCalled();
    expect(fixture.outbox.create).not.toHaveBeenCalled();
  });
});

describe('DocumentService.presignUpload', () => {
  it('binds ciphertext length into the R2 signature and stores only a wrapped data key', async () => {
    const fixture = createFixture();
    const result = await fixture.service.presignUpload(tenantId, actorId, {
      caseId, contentType: 'application/pdf', sizeBytes: 120, sha256: digest,
    });

    expect(fixture.storage.presignPut).toHaveBeenCalledWith(expect.any(String), 'application/pdf', digest, 136, 900);
    expect(fixture.documents.create).toHaveBeenCalledWith(tenantId, actorId, expect.objectContaining({
      sizeBytes: 120, storageSizeBytes: 136, wrappedDataKey: 'v1.wrap.cipher', encryptionKeyVersion: 'v1',
    }), transaction);
    expect(result.encryption).toMatchObject({ algorithm: 'AES-256-GCM', tagLengthBits: 128, ciphertextFormat: 'ciphertext+tag' });
    expect(result.encryption.keyBase64).toBe(Buffer.alloc(32, 7).toString('base64'));
  });

  it('does not copy to R2 before the database reserves a durable finalized key', async () => {
    const fixture = createFixture();
    (fixture.documents.reserveFinalObjectKey as jest.MockedFunction<DocumentRepository['reserveFinalObjectKey']>)
      .mockRejectedValue(new Error('reservation expired'));

    await expect(fixture.service.confirmUpload(tenantId, actorId, documentId, { sha256: digest })).rejects.toThrow('reservation expired');

    expect(fixture.storage.finalizeUpload).not.toHaveBeenCalled();
    expect(fixture.documents.markUploaded).not.toHaveBeenCalled();
  });
});
