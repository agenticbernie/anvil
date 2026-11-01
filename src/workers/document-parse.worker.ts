import { createHash, randomUUID } from 'node:crypto';
import { Injectable, Logger, Inject } from '@nestjs/common';
import type { OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UnrecoverableError, Worker, type ConnectionOptions } from 'bullmq';
import { UNIT_OF_WORK } from '../infrastructure/database/postgres.tokens.js';
import type { UnitOfWork } from '../infrastructure/database/tenant-transaction.js';
import { DOCUMENT_REPOSITORY, DOCUMENT_TEXT_CIPHER, DOCUMENT_VERSION_REPOSITORY, OUTBOX_REPOSITORY, PROCESSING_JOB_REPOSITORY, STORAGE_PROVIDER } from '../modules/documents/documents.tokens.js';
import type {
  DocumentProcessingErrorCode, DocumentProcessingPayload, DocumentRepository, DocumentEncryptionProvider, DocumentTextCipher, DocumentVersionRepository, OutboxRepository,
  ProcessingJobRepository, StorageProvider,
} from '../modules/documents/application/document.types.js';
import { DocumentEncryptionError, DocumentEncryptionService } from '../modules/documents/infrastructure/document-encryption.service.js';
import { BULLMQ_CONNECTION, DOCUMENT_PARSE_QUEUE_NAME } from '../modules/jobs/queue.tokens.js';
import { observeWorker } from './worker-observability.js';

const WORKER_VERSION = 'mock-document-parse-v1';

export class DocumentIntegrityError extends Error {
  constructor(message: string) { super(message); this.name = 'DocumentIntegrityError'; }
}

@Injectable()
export class DocumentParseWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(DocumentParseWorker.name);
  private worker: Worker<DocumentProcessingPayload> | undefined;
  private heartbeat: NodeJS.Timeout | undefined;

  constructor(
    @Inject(DOCUMENT_REPOSITORY) private readonly documents: DocumentRepository,
    @Inject(PROCESSING_JOB_REPOSITORY) private readonly jobs: ProcessingJobRepository,
    @Inject(OUTBOX_REPOSITORY) private readonly outbox: OutboxRepository,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
    @Inject(DocumentEncryptionService) private readonly encryption: DocumentEncryptionProvider,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(DOCUMENT_VERSION_REPOSITORY) private readonly versions: DocumentVersionRepository,
    @Inject(DOCUMENT_TEXT_CIPHER) private readonly textCipher: DocumentTextCipher,
    @Inject(BULLMQ_CONNECTION) private readonly connection: ConnectionOptions,
    private readonly config: ConfigService,
  ) {}

  onApplicationBootstrap(): void {
    this.worker = new Worker<DocumentProcessingPayload>(
      DOCUMENT_PARSE_QUEUE_NAME,
      async (job) => this.processJob(job.data),
      { connection: this.connection, concurrency: this.config.get<number>('redis.workerConcurrency', 1) },
    );
    this.heartbeat = observeWorker(this.worker, this.logger, DOCUMENT_PARSE_QUEUE_NAME);
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    await this.worker?.close();
  }

  async processJob(payload: DocumentProcessingPayload): Promise<void> {
    const scope = { tenantId: payload.tenantId, actorId: payload.actorId };
    const state = await this.unitOfWork.run(scope, async (transaction) => {
      const acquired = await this.jobs.beginAttempt(
        payload.tenantId, payload.actorId, payload.processingJobId, payload.documentId, payload.caseId, transaction,
      );
      if (!acquired.acquired) return { acquired, document: null };
      const document = await this.documents.findById(payload.tenantId, payload.actorId, payload.documentId, transaction);
      if (document?.caseId === payload.caseId) {
        await this.documents.markProcessing(payload.tenantId, payload.actorId, payload.documentId, transaction);
      }
      return { acquired, document };
    });
    if (!state.acquired.acquired) return;

    try {
      const document = state.document;
      if (!document || document.caseId !== payload.caseId) throw new DocumentIntegrityError('Queued document does not match its tenant, case, or job.');
      if (!document.wrappedDataKey || !document.encryptionNonce || !document.encryptionKeyVersion) {
        throw new DocumentEncryptionError('Document encryption metadata is missing.');
      }
      if (!document.finalObjectKey) throw new DocumentIntegrityError('Document has no finalized immutable object.');
      const encryptedStream = await this.storage.getObjectStream(document.finalObjectKey);
      const plaintextStream = this.encryption.decryptStream({
        tenantId: payload.tenantId,
        documentId: document.id,
        wrappedDataKey: document.wrappedDataKey,
        nonceBase64: document.encryptionNonce,
        keyVersion: document.encryptionKeyVersion,
        additionalDataBase64: Buffer.from(`anvil.document:${payload.tenantId}:${document.id}:${document.encryptionKeyVersion}`).toString('base64'),
      }, encryptedStream);
      const result = await hashStream(plaintextStream, document.sizeBytes);
      if (result.sha256 !== document.sha256) throw new DocumentIntegrityError('Uploaded object SHA-256 does not match the presigned declaration.');

      const mockText = `Mock extracted text for document ${document.id}.`;
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (mockText.length === 0) throw new Error('Mock parser returned no text.');
      const documentVersionId = randomUUID();
      const encryptedText = this.textCipher.encrypt(payload.tenantId, documentVersionId, mockText);
      const sourceTextHash = createHash('sha256').update(mockText).digest('hex');

      await this.unitOfWork.run(scope, async (transaction) => {
        await this.versions.create(payload.tenantId, payload.actorId, {
          id: documentVersionId, caseId: payload.caseId, documentId: payload.documentId,
          sourceTextCiphertext: encryptedText.ciphertext, sourceTextNonce: encryptedText.nonce,
          sourceTextKeyVersion: encryptedText.keyVersion, sourcePageCount: 1, sourceTextHash,
        }, transaction);
        await this.jobs.markSucceeded(payload.tenantId, payload.actorId, payload.processingJobId, WORKER_VERSION, transaction);
        await this.documents.markProcessed(payload.tenantId, payload.actorId, payload.documentId, transaction);
        await this.outbox.create(payload.tenantId, payload.actorId, 'document.extract.requested', {
          processingJobId: payload.processingJobId, documentId: payload.documentId,
          documentVersionId, caseId: payload.caseId,
        }, transaction);
      });
    } catch (error) {
      const integrityFailure = error instanceof DocumentIntegrityError || error instanceof DocumentEncryptionError;
      const terminalFailure = integrityFailure || state.acquired.attemptCount >= 3;
      const code = processingErrorCode(error);
      const safeMessage = processingErrorMessage(code);
      await this.unitOfWork.run(scope, async (transaction) => {
        if (terminalFailure) {
          await this.jobs.markDeadLettered(
            payload.tenantId, payload.actorId, payload.processingJobId, code, transaction,
          );
          if (state.document?.caseId === payload.caseId) {
            await this.documents.markFailed(payload.tenantId, payload.actorId, payload.documentId, integrityFailure, transaction);
          }
          await this.outbox.create(payload.tenantId, payload.actorId, 'document.parse.dead_lettered', {
            processingJobId: payload.processingJobId, documentId: payload.documentId, caseId: payload.caseId,
          }, transaction);
        } else {
          await this.jobs.markRetryWait(payload.tenantId, payload.actorId, payload.processingJobId, code, transaction);
        }
      });
      if (integrityFailure) throw new UnrecoverableError(safeMessage);
      throw new Error(safeMessage);
    }
  }
}

async function hashStream(stream: AsyncIterable<Uint8Array>, expectedSize: number): Promise<{ readonly sha256: string; readonly sizeBytes: number }> {
  const hash = createHash('sha256');
  let sizeBytes = 0;
  for await (const chunk of stream) {
    sizeBytes += chunk.byteLength;
    if (sizeBytes > expectedSize) throw new DocumentIntegrityError('Uploaded object exceeds its declared size.');
    hash.update(chunk);
  }
  if (sizeBytes !== expectedSize) throw new DocumentIntegrityError('Uploaded object size does not match its declaration.');
  return { sha256: hash.digest('hex'), sizeBytes };
}

function processingErrorCode(error: unknown): DocumentProcessingErrorCode {
  if (error instanceof DocumentEncryptionError) return 'DOCUMENT_ENCRYPTION_FAILED';
  if (error instanceof DocumentIntegrityError) return 'DOCUMENT_CHECKSUM_MISMATCH';
  return 'DOCUMENT_PARSE_FAILED';
}

function processingErrorMessage(code: DocumentProcessingErrorCode): string {
  switch (code) {
    case 'DOCUMENT_CHECKSUM_MISMATCH': return 'The uploaded document failed integrity verification.';
    case 'DOCUMENT_ENCRYPTION_FAILED': return 'The uploaded document could not be decrypted.';
    case 'DOCUMENT_PARSE_FAILED': return 'Document processing failed.';
  }
}
