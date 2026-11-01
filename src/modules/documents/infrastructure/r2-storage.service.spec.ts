import { describe, expect, it, jest } from '@jest/globals';
import { CopyObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { StorageModule } from '../../../infrastructure/storage/storage.module.js';
import { STORAGE_PROVIDER } from '../documents.tokens.js';
import { R2StorageService } from './r2-storage.service.js';

describe('R2StorageService presigned upload', () => {
  it('signs browser upload headers without adding an automatic checksum for the empty presign body', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => ({ r2: {
          endpoint: 'https://account.r2.cloudflarestorage.com', bucketName: 'anvil-test-bucket', region: 'auto',
          accessKeyId: 'test-access-key', secretAccessKey: 'test-secret-key',
        } })] }),
        StorageModule,
      ],
    }).compile();
    try {
      const storage = module.get<R2StorageService>(STORAGE_PROVIDER);
      const signed = await storage.presignPut('tenant/document', 'application/pdf', 'a'.repeat(64), 136, 900);
      const params = new URL(signed.uploadUrl).searchParams;
      expect(params.has('x-amz-checksum-crc32')).toBe(false);
      expect(params.has('x-amz-sdk-checksum-algorithm')).toBe(false);
      expect(params.has('x-amz-meta-sha256')).toBe(false);
      expect(params.get('X-Amz-SignedHeaders')?.split(';')).toEqual(
        expect.arrayContaining(['content-length', 'content-type', 'host', 'x-amz-meta-sha256']),
      );
      expect(signed.requiredHeaders).toEqual({
        'content-length': '136', 'content-type': 'application/pdf', 'x-amz-meta-sha256': 'a'.repeat(64),
      });
    } finally {
      await module.close();
    }
  });

  it('signs the exact encrypted body length into the URL', async () => {
    const storage = new R2StorageService({
      endpoint: 'https://account.r2.cloudflarestorage.com', bucketName: 'anvil-test-bucket', region: 'auto',
      accessKeyId: 'test-access-key', secretAccessKey: 'test-secret-key',
    }, new S3Client({
      region: 'auto', endpoint: 'https://account.r2.cloudflarestorage.com',
      credentials: { accessKeyId: 'test-access-key', secretAccessKey: 'test-secret-key' },
    }));

    const signed = await storage.presignPut('tenant/document', 'application/pdf', 'a'.repeat(64), 136, 900);

    expect(signed.requiredHeaders['content-length']).toBe('136');
    expect(new URL(signed.uploadUrl).searchParams.get('X-Amz-SignedHeaders')).toContain('content-length');
  });

  it('conditionally finalizes the exact staging object version', async () => {
    const client = { send: jest.fn(async () => ({})) } as unknown as S3Client;
    const storage = new R2StorageService({
      endpoint: 'https://account.r2.cloudflarestorage.com', bucketName: 'anvil-test-bucket', region: 'auto',
      accessKeyId: 'test-access-key', secretAccessKey: 'test-secret-key',
    }, client);

    await storage.finalizeUpload('tenants/t/cases/c/documents/staging/d', 'tenants/t/cases/c/documents/finalized/d/v', '"etag-1"');

    const command = (client.send as jest.Mock).mock.calls[0]?.[0] as CopyObjectCommand;
    expect(command).toBeInstanceOf(CopyObjectCommand);
    expect(command.input.CopySourceIfMatch).toBe('"etag-1"');
    expect(command.input.Key).toContain('/finalized/');
  });

  it('propagates R2 server failures when reading the finalized object', async () => {
    const storageFailure = Object.assign(new Error('R2 request failed'), { $metadata: { httpStatusCode: 500 } });
    const client = { send: jest.fn(async () => { throw storageFailure; }) } as unknown as S3Client;
    const storage = new R2StorageService({
      endpoint: 'https://account.r2.cloudflarestorage.com', bucketName: 'anvil-test-bucket', region: 'auto',
      accessKeyId: 'test-access-key', secretAccessKey: 'test-secret-key',
    }, client);

    await expect(storage.getObjectStream('tenant/document')).rejects.toBe(storageFailure);
  });
});
