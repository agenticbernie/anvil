import 'dotenv/config';

import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { appConfig } from './config/app.config.js';
import { databaseConfig } from './config/database.config.js';
import { llmConfig } from './config/llm.config.js';
import { r2Config } from './config/r2.config.js';
import { redisConfig } from './config/redis.config.js';
import { environmentValidationSchema } from './config/validation.js';
import { createPinoLoggerOptions } from './common/logging/pino.logger.js';
import { DatabaseModule } from './infrastructure/database/database.module.js';
import { AuditModule } from './modules/audit/audit.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { CasesModule } from './modules/cases/cases.module.js';
import { DocumentsModule } from './modules/documents/documents.module.js';
import { ExtractionModule } from './modules/extraction/extraction.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { IdempotencyModule } from './modules/idempotency/idempotency.module.js';
import { MemosModule } from './modules/memos/memos.module.js';
import { ReviewsModule } from './modules/reviews/reviews.module.js';
import { TenantsModule } from './modules/tenants/tenants.module.js';
import { ClerkWebhooksModule } from './modules/webhooks/clerk/clerk-webhooks.module.js';

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
    HealthModule,
    IdempotencyModule,
    AuthModule,
    TenantsModule,
    ClerkWebhooksModule,
    CasesModule,
    DocumentsModule,
    ExtractionModule,
    MemosModule,
    ReviewsModule,
    AuditModule,
  ],
})
export class AppModule {}
