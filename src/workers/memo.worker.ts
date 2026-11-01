import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { Worker, type ConnectionOptions } from 'bullmq';
import { BULLMQ_CONNECTION, MEMO_GENERATE_QUEUE_NAME } from '../modules/jobs/queue.tokens.js';
import { MemoService } from '../modules/memos/application/memo.service.js';
import type { MemoGenerationPayload } from '../modules/memos/application/memo.types.js';
import { observeWorker } from './worker-observability.js';

@Injectable()
export class MemoWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(MemoWorker.name);
  private worker: Worker<MemoGenerationPayload> | undefined;
  private heartbeat: NodeJS.Timeout | undefined;

  constructor(private readonly memos: MemoService, @Inject(BULLMQ_CONNECTION) private readonly connection: ConnectionOptions) {}

  onApplicationBootstrap(): void {
    this.worker = new Worker<MemoGenerationPayload>(
      MEMO_GENERATE_QUEUE_NAME,
      async (job) => this.processJob(job.data),
      { connection: this.connection },
    );
    this.heartbeat = observeWorker(this.worker, this.logger, MEMO_GENERATE_QUEUE_NAME);
  }

  async processJob(payload: MemoGenerationPayload) { return this.memos.generate(payload); }

  async onApplicationShutdown(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    await this.worker?.close();
  }
}
