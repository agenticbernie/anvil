import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from '@jest/globals';
import { RedisContainer } from '@testcontainers/redis';
import { Worker } from 'bullmq';

describe('Phase 5 BullMQ Redis failure mode', () => {
  let container: Awaited<ReturnType<RedisContainer['start']>> | undefined;
  let worker: Worker | undefined;

  afterAll(async () => {
    await worker?.close(true);
    await container?.stop();
  });

  it('surfaces a Redis disconnect through the BullMQ worker error event', async () => {
    container = await new RedisContainer('redis:7-alpine').start();
    worker = new Worker(`phase5-disconnect-${randomUUID()}`, async () => undefined, {
      connection: { url: container.getConnectionUrl(), maxRetriesPerRequest: null },
    });
    await worker.waitUntilReady();

    const workerError = new Promise<{ name: string; message: string }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('BullMQ did not report the Redis disconnect.')), 8_000);
      worker?.once('error', (error: Error) => {
        clearTimeout(timeout);
        resolve({ name: error.name, message: error.message });
      });
    });
    await container.stop();
    container = undefined;

    await expect(workerError).resolves.toEqual(expect.objectContaining({ name: expect.any(String), message: expect.any(String) }));
  }, 120_000);
});
