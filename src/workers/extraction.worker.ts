import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { UnrecoverableError, Worker, type ConnectionOptions } from 'bullmq';
import { BULLMQ_CONNECTION, DOCUMENT_EXTRACT_QUEUE_NAME, DOCUMENT_EXTRACT_QUEUE } from '../modules/jobs/queue.tokens.js';
import { ExtractionService } from '../modules/extraction/application/extraction.service.js';
import type { ExtractionJobPayload } from '../modules/extraction/application/extraction.types.js';

@Injectable()
export class ExtractionWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ExtractionWorker.name);
  private worker: Worker<ExtractionJobPayload> | undefined;

  constructor(
    private readonly extraction: ExtractionService,
    @Inject(BULLMQ_CONNECTION) private readonly connection: ConnectionOptions,
  ) {}

  onApplicationBootstrap(): void {
    this.worker = new Worker<ExtractionJobPayload>(
      DOCUMENT_EXTRACT_QUEUE_NAME,
      async (job) => this.processJob(job.data),
      { connection: this.connection },
    );
    this.worker.on('error', () => this.logger.error('Extraction worker emitted an error; details omitted.'));
  }

  async processJob(payload: ExtractionJobPayload) {
    const result = await this.extraction.process(payload);
    if (result.status === 'failed_validation') throw new UnrecoverableError('Extraction output requires manual review.');
    return result;
  }

  async onApplicationShutdown(): Promise<void> { await this.worker?.close(); }
}
