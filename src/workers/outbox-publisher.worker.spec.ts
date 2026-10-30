import { describe, expect, it, jest } from '@jest/globals';
import type { Queue } from 'bullmq';
import type { UnitOfWork } from '../infrastructure/database/tenant-transaction.js';
import type { OutboxEvent, OutboxRepository } from '../modules/documents/application/document.types.js';
import type { MemoGenerationPayload } from '../modules/memos/application/memo.types.js';
import { OutboxPublisherWorker } from './outbox-publisher.worker.js';

describe('OutboxPublisherWorker memo retention', () => {
  it('bounds completed and failed memo queue records while preserving retries', async () => {
    const event: OutboxEvent = {
      id: '00000000-0000-4000-8000-000000000031',
      tenantId: '00000000-0000-4000-8000-000000000001',
      actorId: '00000000-0000-4000-8000-000000000011',
      eventType: 'memo.generate.requested',
      payload: { caseId: '00000000-0000-4000-8000-000000000021', generationKey: '00000000-0000-4000-8000-000000000061' },
      publishAttempts: 1,
    };
    const outbox = {
      claimPending: jest.fn().mockResolvedValue([event]),
      markPublished: jest.fn().mockResolvedValue(undefined),
      retryOrDeadLetter: jest.fn(),
    } as unknown as OutboxRepository;
    const memoQueue = { add: jest.fn().mockResolvedValue(undefined) } as unknown as Queue<MemoGenerationPayload>;
    const unitOfWork = {
      run: jest.fn(async (_scope: unknown, work: (tx: unknown) => Promise<unknown>) => work({})),
    } as unknown as UnitOfWork;
    const emptyQueue = { add: jest.fn().mockResolvedValue(undefined) } as unknown as Queue<Record<string, never>>;
    const worker = new OutboxPublisherWorker(
      outbox, unitOfWork, emptyQueue as never, emptyQueue as never, emptyQueue as never, memoQueue, emptyQueue,
    );

    await expect(worker.publishPendingBatch()).resolves.toBe(1);

    expect(memoQueue.add).toHaveBeenCalledWith('generate-memo', {
      tenantId: event.tenantId,
      actorId: event.actorId,
      caseId: event.payload.caseId,
      generationKey: event.payload.generationKey,
    }, {
      jobId: event.payload.generationKey,
      attempts: 3,
      backoff: { type: 'exponential', delay: 1_000 },
      removeOnComplete: { age: 86_400, count: 1_000 },
      removeOnFail: { age: 604_800, count: 5_000 },
    });
    expect(outbox.markPublished).toHaveBeenCalledWith(event.tenantId, event.actorId, event.id, expect.anything());
  });
});

describe('OutboxPublisherWorker queue retention', () => {
  const tenantId = '00000000-0000-4000-8000-000000000001';
  const actorId = '00000000-0000-4000-8000-000000000011';
  const caseId = '00000000-0000-4000-8000-000000000021';
  const documentId = '00000000-0000-4000-8000-000000000031';
  const processingJobId = '00000000-0000-4000-8000-000000000041';
  const retention = {
    removeOnComplete: { age: 86_400, count: 1_000 },
    removeOnFail: { age: 604_800, count: 5_000 },
  };

  it('bounds completed and failed jobs on parse, extraction, DLQ, and review queues', async () => {
    const scenarios = [
      { eventType: 'document.uploaded', queue: 'parse', payload: { caseId, documentId, processingJobId } },
      { eventType: 'document.parse.dead_lettered', queue: 'dlq', payload: { caseId, documentId, processingJobId } },
      { eventType: 'document.extract.requested', queue: 'extract', payload: { caseId, documentId, processingJobId, documentVersionId: '00000000-0000-4000-8000-000000000051' } },
      { eventType: 'extraction.needs_manual_review', queue: 'review', payload: { caseId, documentId, extractionRunId: '00000000-0000-4000-8000-000000000061' } },
    ] as const;

    for (const [index, scenario] of scenarios.entries()) {
      const event = {
        id: `00000000-0000-4000-8000-0000000000${70 + index}`,
        tenantId,
        actorId,
        eventType: scenario.eventType,
        payload: scenario.payload,
        publishAttempts: 1,
      } as OutboxEvent;
      const queue = { add: jest.fn().mockResolvedValue(undefined), clean: jest.fn().mockResolvedValue([]) };
      const queues = {
        parse: { add: jest.fn().mockResolvedValue(undefined), clean: jest.fn().mockResolvedValue([]) },
        dlq: { add: jest.fn().mockResolvedValue(undefined), clean: jest.fn().mockResolvedValue([]) },
        extract: { add: jest.fn().mockResolvedValue(undefined), clean: jest.fn().mockResolvedValue([]) },
        review: { add: jest.fn().mockResolvedValue(undefined), clean: jest.fn().mockResolvedValue([]) },
      };
      queues[scenario.queue] = queue;
      const outbox = {
        claimPending: jest.fn().mockResolvedValue([event]),
        markPublished: jest.fn().mockResolvedValue(undefined),
        retryOrDeadLetter: jest.fn(),
      } as unknown as OutboxRepository;
      const unitOfWork = {
        run: jest.fn(async (_scope: unknown, work: (tx: unknown) => Promise<unknown>) => work({})),
      } as unknown as UnitOfWork;
      const worker = new OutboxPublisherWorker(
        outbox, unitOfWork, queues.parse as never, queues.dlq as never, queues.extract as never,
        { add: jest.fn().mockResolvedValue(undefined) } as never, queues.review as never,
      );

      await expect(worker.publishPendingBatch()).resolves.toBe(1);

      expect(queue.add).toHaveBeenCalledWith(expect.any(String), expect.any(Object), expect.objectContaining(retention));
      if (scenario.eventType === 'document.uploaded' || scenario.eventType === 'document.extract.requested') {
        expect(queue.add.mock.calls[0]?.[2]).toMatchObject({
          jobId: scenario.eventType === 'document.uploaded' ? processingJobId : event.id,
          attempts: 3,
          backoff: { type: 'exponential', delay: 1_000 },
        });
      }
      expect(outbox.markPublished).toHaveBeenCalledWith(tenantId, actorId, event.id, expect.anything());
    }
  });

  it('sweeps expired terminal jobs from all queues and notifications from DLQ and review queues', async () => {
    const queues = Array.from({ length: 5 }, () => ({
      add: jest.fn().mockResolvedValue(undefined),
      clean: jest.fn().mockResolvedValue([]),
    }));
    const outbox = { claimPending: jest.fn(), markPublished: jest.fn(), retryOrDeadLetter: jest.fn() } as unknown as OutboxRepository;
    const unitOfWork = { run: jest.fn() } as unknown as UnitOfWork;
    const worker = new OutboxPublisherWorker(
      outbox, unitOfWork, queues[0] as never, queues[1] as never, queues[2] as never,
      queues[3] as never, queues[4] as never,
    );

    await expect(worker.cleanExpiredQueueJobs()).resolves.toBe(0);

    for (const queue of queues) {
      expect(queue.clean).toHaveBeenCalledWith(24 * 60 * 60 * 1_000, 1_000, 'completed');
      expect(queue.clean).toHaveBeenCalledWith(7 * 24 * 60 * 60 * 1_000, 1_000, 'failed');
    }
    for (const queueIndex of [1, 4]) {
      expect(queues[queueIndex].clean).toHaveBeenCalledWith(7 * 24 * 60 * 60 * 1_000, 1_000, 'wait');
      expect(queues[queueIndex].clean).toHaveBeenCalledWith(7 * 24 * 60 * 60 * 1_000, 1_000, 'paused');
    }
  });

  it('repeats a full cleanup batch until no expired jobs remain', async () => {
    const fullBatch = Array.from({ length: 1_000 }, (_, index) => `expired-${index}`);
    const dlqClean = jest.fn()
      .mockResolvedValueOnce(fullBatch)
      .mockResolvedValueOnce(['expired-final'])
      .mockResolvedValue([]);
    const queues = Array.from({ length: 5 }, (_, index) => ({
      add: jest.fn().mockResolvedValue(undefined),
      clean: index === 1 ? dlqClean : jest.fn().mockResolvedValue([]),
    }));
    const outbox = { claimPending: jest.fn(), markPublished: jest.fn(), retryOrDeadLetter: jest.fn() } as unknown as OutboxRepository;
    const unitOfWork = { run: jest.fn() } as unknown as UnitOfWork;
    const worker = new OutboxPublisherWorker(
      outbox, unitOfWork, queues[0] as never, queues[1] as never, queues[2] as never,
      queues[3] as never, queues[4] as never,
    );

    await expect(worker.cleanExpiredQueueJobs()).resolves.toBe(1_001);

    expect(dlqClean).toHaveBeenNthCalledWith(1, 24 * 60 * 60 * 1_000, 1_000, 'completed');
    expect(dlqClean).toHaveBeenNthCalledWith(2, 24 * 60 * 60 * 1_000, 1_000, 'completed');
    expect(dlqClean).toHaveBeenCalledWith(7 * 24 * 60 * 60 * 1_000, 1_000, 'wait');
    expect(dlqClean).toHaveBeenCalledWith(7 * 24 * 60 * 60 * 1_000, 1_000, 'paused');
  });
});
