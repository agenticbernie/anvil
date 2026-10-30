import 'dotenv/config';

import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { appConfig } from '../config/app.config.js';
import { databaseConfig } from '../config/database.config.js';
import { llmConfig } from '../config/llm.config.js';
import { r2Config } from '../config/r2.config.js';
import { redisConfig } from '../config/redis.config.js';
import { environmentValidationSchema } from '../config/validation.js';
import { createPinoLoggerOptions } from '../common/logging/pino.logger.js';
import { DatabaseModule } from '../infrastructure/database/database.module.js';
import { DocumentsModule } from '../modules/documents/documents.module.js';
import { ExtractionModule } from '../modules/extraction/extraction.module.js';
import { MemosModule } from '../modules/memos/memos.module.js';
import { JobsModule } from '../modules/jobs/jobs.module.js';
import { DocumentParseWorker } from './document-parse.worker.js';
import { OutboxPublisherWorker } from './outbox-publisher.worker.js';
import { DocumentReservationCleanupWorker } from './document-reservation-cleanup.worker.js';
import { ExtractionWorker } from './extraction.worker.js';
import { MemoWorker } from './memo.worker.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validationSchema: environmentValidationSchema,
      load: [appConfig, databaseConfig, redisConfig, r2Config, llmConfig],
    }),
    LoggerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: createPinoLoggerOptions,
    }),
    DatabaseModule,
    DocumentsModule,
    ExtractionModule,
    MemosModule,
    JobsModule,
  ],
  providers: [OutboxPublisherWorker, DocumentParseWorker, DocumentReservationCleanupWorker, ExtractionWorker, MemoWorker],
})
export class WorkerModule {}
