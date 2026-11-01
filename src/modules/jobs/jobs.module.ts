import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import type { OnApplicationShutdown } from '@nestjs/common';
import { safeErrorDetails } from '../../common/logging/safe-error-details.js';
import {
  BULLMQ_CONNECTION, DOCUMENT_PARSE_DLQ_QUEUE, DOCUMENT_PARSE_DLQ_QUEUE_NAME,
  DOCUMENT_PARSE_QUEUE, DOCUMENT_PARSE_QUEUE_NAME, DOCUMENT_EXTRACT_QUEUE, DOCUMENT_EXTRACT_QUEUE_NAME,
  MEMO_GENERATE_QUEUE, MEMO_GENERATE_QUEUE_NAME, NEEDS_MANUAL_REVIEW_QUEUE, NEEDS_MANUAL_REVIEW_QUEUE_NAME,
} from './queue.tokens.js';

interface RedisCredentials { readonly url: string; readonly token: string; }

function observeRedis(connection: Redis, credentials: RedisCredentials): void {
  const logger = new Logger('RedisConnection');
  const url = new URL(credentials.url);
  logger.log({ event: 'redis_connecting', urlConfigured: true, tokenConfigured: Boolean(credentials.token), urlPasswordConfigured: Boolean(url.password), tls: url.protocol === 'rediss:' }, 'Connecting to queue Redis');
  const startupTimer = setTimeout(() => {
    if (connection.status !== 'ready') logger.warn({ event: 'redis_not_ready', status: connection.status }, 'Queue Redis has not become ready');
  }, 5_000);
  startupTimer.unref();
  let pingPending = false;
  let lastDisconnectLog = 0;
  connection.on('ready', () => {
    clearTimeout(startupTimer);
    logger.log({ event: 'redis_ready', status: connection.status }, 'Queue Redis connection ready');
    if (pingPending) return;
    pingPending = true;
    const pingTimer = setTimeout(() => logger.warn({ event: 'redis_ping_timeout' }, 'Queue Redis PING did not complete within five seconds'), 5_000);
    pingTimer.unref();
    void connection.ping()
      .then((reply) => logger.log({ event: 'redis_ping', result: reply === 'PONG' ? 'PONG' : 'unexpected' }, 'Queue Redis PING completed'))
      .catch((error: unknown) => logger.error({ event: 'redis_ping_failed', ...safeErrorDetails(error) }, 'Queue Redis PING failed'))
      .finally(() => { clearTimeout(pingTimer); pingPending = false; });
  });
  connection.on('error', (error) => logger.error({ event: 'redis_error', ...safeErrorDetails(error) }, 'Queue Redis connection error'));
  connection.on('reconnecting', (delay: number) => {
    if (Date.now() - lastDisconnectLog < 30_000) return;
    lastDisconnectLog = Date.now();
    logger.warn({ event: 'redis_reconnecting', delayMs: delay }, 'Queue Redis reconnecting');
  });
  connection.on('end', () => clearTimeout(startupTimer));
}

function redisOptions(config: RedisCredentials) {
  if (!config.url) throw new Error('UPSTASH_REDIS_URL is required by the worker process.');
  const url = new URL(config.url);
  if (!['redis:', 'rediss:'].includes(url.protocol)) throw new Error('UPSTASH_REDIS_URL must use redis:// or rediss://.');
  const password = config.token || decodeURIComponent(url.password);
  if (!password) throw new Error('UPSTASH_REDIS_TOKEN or a Redis URL password is required.');
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 6379,
    username: decodeURIComponent(url.username) || 'default',
    password,
    ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  };
}

class QueueShutdown implements OnApplicationShutdown {
  constructor(private readonly queues: readonly Queue[], private readonly connection: Redis) {}
  async onApplicationShutdown(): Promise<void> {
    await Promise.all(this.queues.map((queue) => queue.close()));
    if (this.connection.status !== 'end') await this.connection.quit();
  }
}

@Module({
  providers: [
    {
      provide: BULLMQ_CONNECTION,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const credentials = { url: config.get<string>('redis.url', ''), token: config.get<string>('redis.token', '') };
        const connection = new Redis(redisOptions(credentials));
        observeRedis(connection, credentials);
        return connection;
      },
    },
    {
      provide: DOCUMENT_PARSE_QUEUE,
      inject: [BULLMQ_CONNECTION],
      useFactory: (connection: Redis) => new Queue(DOCUMENT_PARSE_QUEUE_NAME, { connection }),
    },
    {
      provide: DOCUMENT_PARSE_DLQ_QUEUE,
      inject: [BULLMQ_CONNECTION],
      useFactory: (connection: Redis) => new Queue(DOCUMENT_PARSE_DLQ_QUEUE_NAME, { connection }),
    },
    { provide: DOCUMENT_EXTRACT_QUEUE, inject: [BULLMQ_CONNECTION], useFactory: (connection: Redis) => new Queue(DOCUMENT_EXTRACT_QUEUE_NAME, { connection }) },
    { provide: MEMO_GENERATE_QUEUE, inject: [BULLMQ_CONNECTION], useFactory: (connection: Redis) => new Queue(MEMO_GENERATE_QUEUE_NAME, { connection }) },
    { provide: NEEDS_MANUAL_REVIEW_QUEUE, inject: [BULLMQ_CONNECTION], useFactory: (connection: Redis) => new Queue(NEEDS_MANUAL_REVIEW_QUEUE_NAME, { connection }) },
    {
      provide: 'DOCUMENT_QUEUE_SHUTDOWN',
      inject: [DOCUMENT_PARSE_QUEUE, DOCUMENT_PARSE_DLQ_QUEUE, DOCUMENT_EXTRACT_QUEUE, MEMO_GENERATE_QUEUE, NEEDS_MANUAL_REVIEW_QUEUE, BULLMQ_CONNECTION],
      useFactory: (parse: Queue, dlq: Queue, extract: Queue, memo: Queue, review: Queue, connection: Redis) => new QueueShutdown([parse, dlq, extract, memo, review], connection),
    },
  ],
  exports: [BULLMQ_CONNECTION, DOCUMENT_PARSE_QUEUE, DOCUMENT_PARSE_DLQ_QUEUE, DOCUMENT_EXTRACT_QUEUE, MEMO_GENERATE_QUEUE, NEEDS_MANUAL_REVIEW_QUEUE],
})
export class JobsModule {}
