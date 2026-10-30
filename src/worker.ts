import 'reflect-metadata';

import { Logger } from 'nestjs-pino';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './workers/worker.module.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();

}

void bootstrap();
