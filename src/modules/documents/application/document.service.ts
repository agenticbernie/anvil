import { BadRequestException, ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { AuditEventRepository } from '../../audit/audit.types.js';
import type { UnitOfWork } from '../../../infrastructure/database/tenant-transaction.js';
import type { CaseRepository } from '../../cases/application/case.types.js';
import type {
  DocumentContentType, DocumentEncryptionProvider, DocumentListItem, DocumentRepository, OutboxRepository, ProcessingJobRepository,
  ProcessingJobStatus, StorageProvider,
} from './document.types.js';

export interface PresignDocumentInput {
  readonly caseId: string;
  readonly contentType: DocumentContentType;
  readonly sizeBytes: number;
  readonly sha256: string;
}

export interface ConfirmUploadInput {
  readonly sha256: string;
}

export interface AcceptedProcessingJob {
  readonly jobId: string;
  readonly status: ProcessingJobStatus;
}

@Injectable()
export class DocumentService {
  constructor(
    private readonly documents: DocumentRepository,
    private readonly jobs: ProcessingJobRepository,
    private readonly outbox: OutboxRepository,
    private readonly cases: CaseRepository,
    private readonly storage: StorageProvider,
    private readonly audit: AuditEventRepository,
    private readonly unitOfWork: UnitOfWork,
    private readonly encryption: DocumentEncryptionProvider,
    private readonly maxUploadBytes = 52_428_800,
  ) {}

  async listForCase(tenantId: string, actorId: string, caseId: string): Promise<readonly DocumentListItem[]> {
    return this.unitOfWork.run({ tenantId, actorId }, async (transaction) => {
      const creditCase = await this.cases.findById(tenantId, actorId, caseId, transaction);
      if (!creditCase || creditCase.deletedAt !== null || creditCase.status === 'archived') {
        throw new NotFoundException('Active credit case not found.');
      }
      return this.documents.listByCase(tenantId, actorId, caseId, transaction);
    });
  }

  async presignUpload(tenantId: string, actorId: string, input: PresignDocumentInput) {
    if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 1 || input.sizeBytes > this.maxUploadBytes) {
      throw new BadRequestException(`sizeBytes must be between 1 and ${this.maxUploadBytes}.`);
    }
    const sha256 = normalizeSha256(input.sha256);
    const documentId = randomUUID();
    const objectKey = `tenants/${tenantId}/cases/${input.caseId}/documents/staging/${documentId}`;
    const encryption = this.encryption.createUploadMaterial(tenantId, documentId);
    const storageSizeBytes = input.sizeBytes + 16;
    const signed = await this.storage.presignPut(objectKey, input.contentType, sha256, storageSizeBytes, 900);

    await this.unitOfWork.run({ tenantId, actorId }, async (transaction) => {
      const creditCase = await this.cases.findById(tenantId, actorId, input.caseId, transaction);
      if (!creditCase || creditCase.deletedAt !== null || creditCase.status === 'archived') {
        throw new NotFoundException('Active credit case not found.');
      }
      await this.documents.create(tenantId, actorId, {
        id: documentId, caseId: input.caseId, objectKey, contentType: input.contentType,
        sizeBytes: input.sizeBytes, storageSizeBytes, sha256,
        wrappedDataKey: encryption.wrappedDataKey, encryptionNonce: encryption.nonceBase64,
        encryptionKeyVersion: encryption.keyVersion,
      }, transaction);
      await this.audit.record(tenantId, actorId, {
        type: 'document.upload.presigned', resourceType: 'document', resourceId: documentId,
        metadata: { caseId: input.caseId, contentType: input.contentType, sizeBytes: input.sizeBytes },
      }, transaction);
    });

    return {
      documentId,
      ...signed,
      encryption: {
        algorithm: 'AES-256-GCM' as const,
        keyBase64: encryption.uploadKeyBase64,
        nonceBase64: encryption.nonceBase64,
        additionalDataBase64: encryption.additionalDataBase64,
        tagLengthBits: 128 as const,
        ciphertextFormat: 'ciphertext+tag' as const,
      },
    };
  }

  async confirmUpload(tenantId: string, actorId: string, documentId: string, input: ConfirmUploadInput): Promise<AcceptedProcessingJob> {
    const sha256 = normalizeSha256(input.sha256);
    const document = await this.unitOfWork.run({ tenantId, actorId }, (transaction) =>
      this.documents.findById(tenantId, actorId, documentId, transaction));
    if (!document) throw new NotFoundException('Document not found.');
    if (document.sha256 !== sha256) throw new UnprocessableEntityException('SHA-256 does not match the upload declaration.');
    if (!document.wrappedDataKey || !document.encryptionNonce || !document.encryptionKeyVersion || document.encryptionKeyVersion === 'legacy-plaintext') {
      throw new ConflictException('This document must be uploaded again using application encryption.');
    }

    if (document.status !== 'pending_upload') {
      const existing = await this.unitOfWork.run({ tenantId, actorId }, (transaction) =>
        this.jobs.findForDocument(tenantId, actorId, documentId, transaction));
      if (existing) return { jobId: existing.id, status: existing.status };
      throw new ConflictException('Document is no longer awaiting upload confirmation.');
    }

    const object = await this.storage.headObject(document.objectKey);
    if (!object) throw new ConflictException('Uploaded object is not present in R2.');
    if (object.contentLength !== document.storageSizeBytes || object.contentType !== document.contentType) {
      throw new UnprocessableEntityException('Uploaded object size or content type does not match the presigned request.');
    }
    if (object.sha256Metadata?.toLowerCase() !== document.sha256) {
      throw new UnprocessableEntityException('R2 object metadata does not match the declared SHA-256.');
    }
    if (!object.eTag) throw new ConflictException('R2 did not return an object version validator.');

    const finalObjectKey = `tenants/${tenantId}/cases/${document.caseId}/documents/finalized/${document.id}/${randomUUID()}`;
    const reservedFinalObjectKey = await this.unitOfWork.run({ tenantId, actorId }, (transaction) =>
      this.documents.reserveFinalObjectKey(tenantId, actorId, documentId, finalObjectKey, transaction));
    await this.storage.finalizeUpload(document.objectKey, reservedFinalObjectKey, object.eTag);

    const outcome = await this.unitOfWork.run({ tenantId, actorId }, async (transaction) => {
      const current = await this.documents.findById(tenantId, actorId, documentId, transaction);
      if (!current) throw new NotFoundException('Document not found.');
      if (current.status !== 'pending_upload') {
        const existing = await this.jobs.findForDocument(tenantId, actorId, documentId, transaction);
        if (existing) return { accepted: false as const, result: { jobId: existing.id, status: existing.status } };
        throw new ConflictException('Document is no longer awaiting upload confirmation.');
      }

      const updated = await this.documents.markUploaded(tenantId, actorId, documentId, reservedFinalObjectKey, transaction);
      if (!updated) {
        const existing = await this.jobs.findForDocument(tenantId, actorId, documentId, transaction);
        if (existing) return { accepted: false as const, result: { jobId: existing.id, status: existing.status } };
        throw new ConflictException('Document upload confirmation raced with another request or expired.');
      }
      const job = await this.jobs.create(tenantId, actorId, current.caseId, current.id, transaction);
      const payload = { processingJobId: job.id, documentId: current.id, caseId: current.caseId };
      await this.outbox.create(tenantId, actorId, 'document.uploaded', payload, transaction);
      await this.audit.record(tenantId, actorId, {
        type: 'document.upload.confirmed', resourceType: 'document', resourceId: current.id,
        metadata: { caseId: current.caseId, processingJobId: job.id, status: 'uploaded' },
      }, transaction);
      return { accepted: true as const, result: { jobId: job.id, status: 'queued' as const } };
    });

    return outcome.result;
  }
}

export function sha256Hex(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeSha256(value: string): string {
  const digest = value.toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new BadRequestException('sha256 must be a 64-character hexadecimal digest.');
  return digest;
}
