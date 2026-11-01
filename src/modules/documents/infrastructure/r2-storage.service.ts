import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { StorageHead, StorageProvider, PresignedUpload } from '../application/document.types.js';

export interface R2StorageConfig {
  readonly endpoint: string;
  readonly bucketName: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

@Injectable()
export class R2StorageService implements StorageProvider {
  constructor(private readonly config: R2StorageConfig, private readonly client: S3Client) {}

  async presignPut(
    objectKey: string,
    contentType: string,
    sha256: string,
    contentLengthBytes: number,
    expiresInSeconds: number,
  ): Promise<PresignedUpload> {
    this.assertConfigured();
    if (!Number.isSafeInteger(contentLengthBytes) || contentLengthBytes < 1) {
      throw new RangeError('Upload content length must be a positive safe integer.');
    }
    if (expiresInSeconds < 1 || expiresInSeconds > 900) throw new RangeError('Upload URL expiry must be between 1 and 900 seconds.');
    const requiredHeaders = {
      'content-length': String(contentLengthBytes),
      'content-type': contentType,
      'x-amz-meta-sha256': sha256,
    };
    const uploadUrl = await getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.config.bucketName,
        Key: objectKey,
        ContentLength: contentLengthBytes,
        ContentType: contentType,
        Metadata: { sha256 },
      }),
      {
        expiresIn: expiresInSeconds,
        signableHeaders: new Set(['content-length', 'content-type']),
        unhoistableHeaders: new Set(['x-amz-meta-sha256']),
      },
    );
    return { uploadUrl, requiredHeaders, expiresAt: new Date(Date.now() + expiresInSeconds * 1_000).toISOString() };
  }

  async headObject(objectKey: string): Promise<StorageHead | null> {
    this.assertConfigured();
    try {
      const result = await this.client.send(new HeadObjectCommand({ Bucket: this.config.bucketName, Key: objectKey }));
      if (typeof result.ContentLength !== 'number') throw new ServiceUnavailableException('R2 did not return the object size.');
      return {
        contentLength: result.ContentLength,
        contentType: result.ContentType,
        sha256Metadata: result.Metadata?.sha256,
        eTag: result.ETag,
      };
    } catch (error) {
      const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (candidate.$metadata?.httpStatusCode === 404 || candidate.name === 'NotFound' || candidate.name === 'NoSuchKey') return null;
      throw error;
    }
  }

  async finalizeUpload(stagingKey: string, finalKey: string, expectedETag: string): Promise<void> {
    this.assertConfigured();
    if (!expectedETag || stagingKey === finalKey) throw new RangeError('A distinct staging key and source ETag are required.');
    const copySource = `${encodeURIComponent(this.config.bucketName)}/${stagingKey.split('/').map(encodeURIComponent).join('/')}`;
    await this.client.send(new CopyObjectCommand({
      Bucket: this.config.bucketName,
      Key: finalKey,
      CopySource: copySource,
      CopySourceIfMatch: expectedETag,
      MetadataDirective: 'COPY',
    }));
  }

  async deleteObject(objectKey: string): Promise<void> {
    this.assertConfigured();
    await this.client.send(new DeleteObjectCommand({ Bucket: this.config.bucketName, Key: objectKey }));
  }

  async getObjectStream(objectKey: string): Promise<AsyncIterable<Uint8Array>> {
    this.assertConfigured();
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.config.bucketName, Key: objectKey }));
    const body = result.Body;
    if (!body || typeof (body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] !== 'function') {
      throw new ServiceUnavailableException('R2 returned no readable object stream.');
    }
    return body as AsyncIterable<Uint8Array>;
  }

  private assertConfigured(): void {
    if (!this.config.endpoint || !this.config.bucketName || !this.config.accessKeyId || !this.config.secretAccessKey) {
      throw new ServiceUnavailableException('R2 storage is not configured.');
    }
  }
}
