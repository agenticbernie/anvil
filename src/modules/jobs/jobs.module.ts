import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import type { OnApplicationShutdown } from '@nestjs/common';
import {
  BULLMQ_CONNECTION, DOCUMENT_PARSE_DLQ_QUEUE, DOCUMENT_PARSE_DLQ_QUEUE_NAME,
  DOCUMENT_PARSE_QUEUE, DOCUMENT_PARSE_QUEUE_NAME, DOCUMENT_EXTRACT_QUEUE, DOCUMENT_EXTRACT_QUEUE_NAME,
  MEMO_GENERATE_QUEUE, MEMO_GENERATE_QUEUE_NAME, NEEDS_MANUAL_REVIEW_QUEUE, NEEDS_MANUAL_REVIEW_QUEUE_NAME,
} from './queue.tokens.js';

interface RedisCredentials { readonly url: string; readonly token: string; }

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
      useFactory: (config: ConfigService) => new Redis(redisOptions({
        url: config.get<string>('redis.url', ''),
        token: config.get<string>('redis.token', ''),
      })),
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
