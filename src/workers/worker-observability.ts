import { Logger } from '@nestjs/common';
import type { Job, Worker } from 'bullmq';
import { safeErrorDetails } from '../common/logging/safe-error-details.js';

const HEARTBEAT_INTERVAL_MS = 60_000;
const KNOWN_JOB_NAMES = new Set(['parse-document', 'extract-document', 'generate-memo']);
export function observeWorker<T>(worker: Worker<T>, logger: Logger, queue: string): NodeJS.Timeout {
  let readyObserved = false;
  logger.log({ event: 'consumer_starting', queue }, 'Queue consumer starting');
  worker.on('ready', () => {
    readyObserved = true;
    logger.log({ event: 'consumer_ready', queue }, 'Queue consumer is active and listening');
  });
  worker.on('active', (job) => logger.log(jobDetails('job_received', queue, job), 'Queue job received'));
  worker.on('completed', (job) => logger.log(jobDetails('job_completed', queue, job), 'Queue job completed'));
  worker.on('failed', (job, error) => logger.error({ ...jobDetails('job_failed', queue, job), ...safeErrorDetails(error) }, 'Queue job failed'));
  worker.on('stalled', (jobId) => logger.warn({ event: 'job_stalled', queue, jobId: safeJobId(jobId) }, 'Queue job stalled'));
  worker.on('error', (error) => logger.error({ event: 'consumer_error', queue, ...safeErrorDetails(error) }, 'Queue consumer error'));
  worker.on('closed', () => { readyObserved = false; });
  const timer = setInterval(() => {
    logger.log({ event: 'consumer_heartbeat', queue, running: worker.isRunning(), readyObserved }, 'Queue consumer heartbeat');
  }, HEARTBEAT_INTERVAL_MS);
  timer.unref();
  return timer;
}

function jobDetails(event: string, queue: string, job?: Job): Record<string, unknown> {
  return {
    event, queue,
    jobId: safeJobId(job?.id),
    jobName: job && KNOWN_JOB_NAMES.has(job.name) ? job.name : 'unrecognized',
    attemptsMade: job?.attemptsMade,
    payloadType: job ? (job.data === null ? 'null' : Array.isArray(job.data) ? 'array' : typeof job.data) : 'unavailable',
  };
}

export function safeJobId(value: string | undefined): string {
  return value && (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) || /^\d{1,20}$/.test(value))
    ? value
    : '[redacted]';
}
