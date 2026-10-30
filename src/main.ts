import 'reflect-metadata';

import { Logger } from 'nestjs-pino';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true, rawBody: true });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));

  const config = app.get(ConfigService);
  const prefix = config.get<string>('app.apiPrefix', 'v1');
  const requestIdHeader = config.get<string>('app.requestIdHeader', 'x-request-id');
  const corsOrigins = config.get<string>('app.corsOrigins', '');
  const port = config.get<number>('app.port', 3000);

  app.setGlobalPrefix(prefix, {
    exclude: ['health/live', 'health/ready', 'health/dependencies'],
  });
  app.enableCors({
    origin: corsOrigins.length > 0 ? corsOrigins.split(',').map((origin) => origin.trim()) : false,
    exposedHeaders: [requestIdHeader],
  });

  const swaggerEnabled = config.get<boolean>('app.swaggerEnabled', true);
  if (swaggerEnabled) {
    const documentConfig = new DocumentBuilder()
      .setTitle('Anvil API')
      .setDescription('OpenAPI contract for the Anvil underwriting platform.')
      .setVersion('1.0.0')
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, documentConfig);
    SwaggerModule.setup('docs', app, document, {
      jsonDocumentUrl: 'openapi.json',
    });
  }

  await app.listen(port, '0.0.0.0');
}

void bootstrap();
