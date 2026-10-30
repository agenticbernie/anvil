import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3Client } from '@aws-sdk/client-s3';
import { STORAGE_PROVIDER } from '../../modules/documents/documents.tokens.js';
import { R2StorageService, type R2StorageConfig } from '../../modules/documents/infrastructure/r2-storage.service.js';

@Module({
  providers: [{
    provide: STORAGE_PROVIDER,
    inject: [ConfigService],
    useFactory: (config: ConfigService) => {
      const r2: R2StorageConfig = {
        endpoint: config.get<string>('r2.endpoint', ''),
        bucketName: config.get<string>('r2.bucketName', ''),
        region: config.get<string>('r2.region', 'auto'),
        accessKeyId: config.get<string>('r2.accessKeyId', ''),
        secretAccessKey: config.get<string>('r2.secretAccessKey', ''),
      };
      const client = new S3Client({
        region: r2.region,
        ...(r2.endpoint ? { endpoint: r2.endpoint } : {}),
        ...(r2.accessKeyId && r2.secretAccessKey
          ? { credentials: { accessKeyId: r2.accessKeyId, secretAccessKey: r2.secretAccessKey } }
          : {}),
      });
      return new R2StorageService(r2, client);
    },
  }],
  exports: [STORAGE_PROVIDER],
})
export class StorageModule {}
