import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { OpenAPIObject } from '@nestjs/swagger';
import { OpenApiModule } from './openapi.module.js';

export async function createOpenApiDocument(): Promise<OpenAPIObject> {
  const app = await NestFactory.create(OpenApiModule, { logger: false });
  try {
    app.setGlobalPrefix(process.env.API_PREFIX || 'v1', { exclude: ['health/live', 'health/ready', 'health/dependencies'] });
    await app.init();
    return SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('Anvil API')
        .setDescription('OpenAPI contract for the Anvil underwriting platform.')
        .setVersion('1.0.0')
        .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'bearer')
        .build(),
      { operationIdFactory: (controllerKey, methodKey) => `${controllerKey}_${methodKey}` },
    );
  } finally {
    await app.close();
  }
}
