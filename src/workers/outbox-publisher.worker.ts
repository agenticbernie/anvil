import { Injectable, Logger } from '@nestjs/common';
import type { OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { UNIT_OF_WORK } from '../infrastructure/database/postgres.tokens.js';
import type { UnitOfWork } from '../infrastructure/database/tenant-transaction.js';
import { OUTBOX_REPOSITORY } from '../modules/documents/documents.tokens.js';
import type { DocumentProcessingPayload, OutboxEvent, OutboxRepository } from '../modules/documents/application/document.types.js';
import {
  DOCUMENT_PARSE_DLQ_QUEUE, DOCUMENT_PARSE_QUEUE, DOCUMENT_EXTRACT_QUEUE, MEMO_GENERATE_QUEUE, NEEDS_MANUAL_REVIEW_QUEUE,
} from '../modules/jobs/queue.tokens.js';
import type { ExtractionJobPayload } from '../modules/extraction/application/extraction.types.js';
import type { MemoGenerationPayload } from '../modules/memos/application/memo.types.js';
import { Inject } from '@nestjs/common';
import { safeErrorDetails } from '../common/logging/safe-error-details.js';

const COMPLETED_JOB_RETENTION = { age: 24 * 60 * 60, count: 1_000 };
const FAILED_JOB_RETENTION = { age: 7 * 24 * 60 * 60, count: 5_000 };
const COMPLETED_JOB_RETENTION_MS = COMPLETED_JOB_RETENTION.age * 1_000;
const FAILED_JOB_RETENTION_MS = FAILED_JOB_RETENTION.age * 1_000;
const NOTIFICATION_WAITING_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const QUEUE_CLEANUP_INTERVAL_MS = 60 * 60 * 1_000;
const QUEUE_CLEANUP_BATCH_SIZE = 1_000;
const SCAN_LOG_INTERVAL_MS = 30_000;

type CleanableQueueState = 'completed' | 'failed' | 'wait' | 'paused';

@Injectable()
export class OutboxPublisherWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(OutboxPublisherWorker.name);
  private pollTimer: NodeJS.Timeout | undefined;
  private queueCleanupTimer: NodeJS.Timeout | undefined;
  private polling = false;
  private queueCleanupRunning = false;
  private lastScanLogAt = 0;
  private pollStartedAt = 0;
  private lastBusyLogAt = 0;

  constructor(
    @Inject(OUTBOX_REPOSITORY) private readonly outbox: OutboxRepository,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(DOCUMENT_PARSE_QUEUE) private readonly parseQueue: Queue<DocumentProcessingPayload>,
    @Inject(DOCUMENT_PARSE_DLQ_QUEUE) private readonly dlqQueue: Queue<DocumentProcessingPayload>,
    @Inject(DOCUMENT_EXTRACT_QUEUE) private readonly extractionQueue: Queue<ExtractionJobPayload>,
    @Inject(MEMO_GENERATE_QUEUE) private readonly memoQueue: Queue<MemoGenerationPayload>,
    @Inject(NEEDS_MANUAL_REVIEW_QUEUE) private readonly reviewQueue: Queue<Record<string, string>>,
  ) {}

  onApplicationBootstrap(): void {
    this.logger.log({ event: 'outbox_publisher_started', pollIntervalMs: 1_000 }, 'Outbox publisher started');
    void this.poll();
    this.pollTimer = setInterval(() => { void this.poll().catch((error: unknown) => this.logFailure(error)); }, 1_000);
    this.pollTimer.unref();
    this.queueCleanupTimer = setInterval(() => {
      void this.cleanExpiredQueueJobs().catch((error: unknown) => this.logFailure(error));
    }, QUEUE_CLEANUP_INTERVAL_MS);
    this.queueCleanupTimer.unref();
    void this.cleanExpiredQueueJobs().catch((error: unknown) => this.logFailure(error));
  }

  onApplicationShutdown(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.queueCleanupTimer) clearInterval(this.queueCleanupTimer);
  }

  async publishPendingBatch(limit = 25): Promise<number> {
    if (Date.now() - this.lastScanLogAt >= SCAN_LOG_INTERVAL_MS) {
      this.lastScanLogAt = Date.now();
      this.logger.log({ event: 'outbox_scan', limit }, 'Scanning pending and expired publishing outbox events');
    }
    const events = await this.outbox.claimPending(limit);
    if (events.length > 0) this.logger.log({ event: 'outbox_claimed', count: events.length }, 'Outbox events claimed');
    for (const event of events) await this.publishOne(event);
    return events.length;
  }

  async cleanExpiredQueueJobs(): Promise<number> {
    if (this.queueCleanupRunning) return 0;
    this.queueCleanupRunning = true;
    try {
      const results = await Promise.allSettled([
        this.cleanQueueStates(this.parseQueue, [['completed', COMPLETED_JOB_RETENTION_MS], ['failed', FAILED_JOB_RETENTION_MS]]),
        this.cleanQueueStates(this.dlqQueue, [
          ['completed', COMPLETED_JOB_RETENTION_MS], ['failed', FAILED_JOB_RETENTION_MS],
          ['wait', NOTIFICATION_WAITING_RETENTION_MS], ['paused', NOTIFICATION_WAITING_RETENTION_MS],
        ]),
        this.cleanQueueStates(this.extractionQueue, [['completed', COMPLETED_JOB_RETENTION_MS], ['failed', FAILED_JOB_RETENTION_MS]]),
        this.cleanQueueStates(this.memoQueue, [['completed', COMPLETED_JOB_RETENTION_MS], ['failed', FAILED_JOB_RETENTION_MS]]),
        this.cleanQueueStates(this.reviewQueue, [
          ['completed', COMPLETED_JOB_RETENTION_MS], ['failed', FAILED_JOB_RETENTION_MS],
          ['wait', NOTIFICATION_WAITING_RETENTION_MS], ['paused', NOTIFICATION_WAITING_RETENTION_MS],
        ]),
      ]);
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failures.length > 0) throw new AggregateError(failures.map((failure) => failure.reason), 'One or more BullMQ retention sweeps failed.');
      return results.reduce((total, result) => total + (result.status === 'fulfilled' ? result.value : 0), 0);
    } finally {
      this.queueCleanupRunning = false;
    }
  }

  private async cleanQueueStates(queue: Queue, states: readonly (readonly [CleanableQueueState, number])[]): Promise<number> {
    let removedCount = 0;
    for (const [state, graceMs] of states) {
      while (true) {
        const removed = await queue.clean(graceMs, QUEUE_CLEANUP_BATCH_SIZE, state);
        removedCount += removed.length;
        if (removed.length < QUEUE_CLEANUP_BATCH_SIZE) break;
      }
    }
    return removedCount;
  }

  private async publishOne(event: OutboxEvent): Promise<void> {
    try {
      switch (event.eventType) {
        case 'document.uploaded': {
          const payload: DocumentProcessingPayload = {
            processingJobId: requireString(event.payload.processingJobId), documentId: requireString(event.payload.documentId),
            caseId: event.payload.caseId, tenantId: event.tenantId, actorId: event.actorId,
          };
          await this.parseQueue.add('parse-document', payload, retryOptions(event.payload.processingJobId));
          break;
        }
        case 'document.parse.dead_lettered': {
          const payload: DocumentProcessingPayload = {
            processingJobId: requireString(event.payload.processingJobId), documentId: requireString(event.payload.documentId),
            caseId: event.payload.caseId, tenantId: event.tenantId, actorId: event.actorId,
          };
          await this.dlqQueue.add('dead-letter-document', payload, { jobId: payload.processingJobId, ...retentionOptions() });
          break;
        }
        case 'document.extract.requested': {
          const payload: ExtractionJobPayload = {
            processingJobId: requireString(event.payload.processingJobId), documentId: requireString(event.payload.documentId),
            documentVersionId: requireString(event.payload.documentVersionId), caseId: event.payload.caseId,
            tenantId: event.tenantId, actorId: event.actorId,
          };
          await this.extractionQueue.add('extract-document', payload, retryOptions(event.id));
          break;
        }
        case 'extraction.needs_manual_review':
          await this.reviewQueue.add('manual-review-needed', {
            tenantId: event.tenantId, actorId: event.actorId, caseId: event.payload.caseId,
            documentId: requireString(event.payload.documentId), extractionRunId: requireString(event.payload.extractionRunId),
          }, { jobId: event.id, ...retentionOptions() });
          break;
        case 'memo.generate.requested': {
          const payload: MemoGenerationPayload = {
            tenantId: event.tenantId, actorId: event.actorId, caseId: event.payload.caseId,
            generationKey: requireString(event.payload.generationKey),
          };
          await this.memoQueue.add('generate-memo', payload, memoRetryOptions(payload.generationKey));
          break;
        }
      }
      this.logger.log({ event: 'outbox_enqueued', eventId: event.id, eventType: event.eventType }, 'Outbox event pushed to queue');
      await this.unitOfWork.run({ tenantId: event.tenantId, actorId: event.actorId }, (transaction) =>
        this.outbox.markPublished(event.tenantId, event.actorId, event.id, transaction));
      this.logger.log({ event: 'outbox_published', eventId: event.id, eventType: event.eventType }, 'Outbox event marked published');
    } catch (error) {
      this.logger.error({ event: 'outbox_publish_failed', eventId: event.id, eventType: event.eventType, ...safeErrorDetails(error) }, 'Failed to publish outbox event');
      try {
        await this.unitOfWork.run({ tenantId: event.tenantId, actorId: event.actorId }, (transaction) =>
          this.outbox.retryOrDeadLetter(event.tenantId, event.actorId, event, errorMessage(error), transaction));
      } catch (releaseError) {
        throw new AggregateError([error, releaseError], `Outbox event ${event.id} failed to publish and release.`);
      }
      throw error;
    }
  }

  private async poll(): Promise<void> {
    if (this.polling) {
      if (Date.now() - this.lastBusyLogAt >= SCAN_LOG_INTERVAL_MS && Date.now() - this.pollStartedAt >= SCAN_LOG_INTERVAL_MS) {
        this.lastBusyLogAt = Date.now();
        this.logger.warn({ event: 'outbox_poll_still_running', durationMs: Date.now() - this.pollStartedAt }, 'Outbox poll is still waiting on database or queue');
      }
      return;
    }
    this.polling = true;
    this.pollStartedAt = Date.now();
    try {
      await this.publishPendingBatch();
    } catch (error) {
      this.logFailure(error);
    } finally {
      this.polling = false;
    }
  }

  private logFailure(error: unknown): void {
    this.logger.error({ event: 'outbox_cycle_failed', ...safeErrorDetails(error) }, 'Outbox publisher cycle failed');
  }
}

function retryOptions(jobId: string | undefined) {
  return {
    ...(jobId ? { jobId } : {}), attempts: 3, backoff: { type: 'exponential' as const, delay: 1_000 },
    ...retentionOptions(),
  };
}

function retentionOptions() {
  return {
    removeOnComplete: { ...COMPLETED_JOB_RETENTION },
    removeOnFail: { ...FAILED_JOB_RETENTION },
  };
}

function memoRetryOptions(jobId: string | undefined) {
  return {
    ...(jobId ? { jobId } : {}), attempts: 3, backoff: { type: 'exponential' as const, delay: 1_000 },
    ...retentionOptions(),
  };
}

function requireString(value: string | undefined): string {
  if (!value) throw new TypeError('Outbox event payload is missing a required identifier.');
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : 'Unknown publishing failure.';
}
