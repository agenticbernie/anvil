import { EventEmitter } from 'node:events';
import { describe, expect, it, jest } from '@jest/globals';
import type { Logger } from '@nestjs/common';
import type { Worker } from 'bullmq';
import { observeWorker } from './worker-observability.js';

describe('worker observability', () => {
  it('logs readiness, received jobs, failures and heartbeat without logging payloads or secrets', () => {
    jest.useFakeTimers();
    const emitter = new EventEmitter();
    const worker = Object.assign(emitter, { isRunning: () => true }) as unknown as Worker;
    const log = jest.fn();
    const error = jest.fn();
    const logger = { log, error, warn: jest.fn() } as unknown as Logger;
    const timer = observeWorker(worker, logger, 'document.extract');
    try {
      emitter.emit('ready');
      emitter.emit('active', { id: 'secret-job-id', name: 'secret-job-name', data: { password: 'private-payload' }, attemptsMade: 0 });
      emitter.emit('error', Object.assign(new Error('private-redis-credential'), { code: 'ECONNREFUSED' }));
      jest.advanceTimersByTime(60_000);
      const logs = JSON.stringify([log.mock.calls, error.mock.calls]);
      expect(logs).toContain('consumer_ready');
      expect(logs).toContain('job_received');
      expect(logs).toContain('consumer_heartbeat');
      expect(logs).toContain('ECONNREFUSED');
      expect(logs).not.toContain('private-payload');
      expect(logs).not.toContain('private-redis-credential');
      expect(logs).not.toContain('secret-job-id');
      expect(logs).not.toContain('secret-job-name');
    } finally {
      clearInterval(timer);
      jest.useRealTimers();
    }
  });
});
