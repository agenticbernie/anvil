import { createCipheriv } from 'node:crypto';
import { describe, expect, it } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import { DocumentEncryptionError, DocumentEncryptionService } from './document-encryption.service.js';

const tenantId = '00000000-0000-4000-8000-000000000001';
const documentId = '00000000-0000-4000-8000-000000000031';
const rootKey = Buffer.alloc(32, 23);

describe('DocumentEncryptionService', () => {
  it('wraps each data key and decrypts an authenticated AES-GCM stream', async () => {
    const encryption = createEncryption();
    const material = encryption.createUploadMaterial(tenantId, documentId);
    const plaintext = Buffer.from('underwriting document bytes');
    const encrypted = encryptForClient(plaintext, material.uploadKeyBase64, material.nonceBase64, material.additionalDataBase64);

    const result = await collect(encryption.decryptStream({
      tenantId, documentId, wrappedDataKey: material.wrappedDataKey, nonceBase64: material.nonceBase64,
      keyVersion: material.keyVersion, additionalDataBase64: material.additionalDataBase64,
    }, chunks(encrypted)));

    expect(result).toEqual(plaintext);
    expect(material.wrappedDataKey).not.toContain(material.uploadKeyBase64);
  });

  it('rejects modified ciphertext instead of returning unauthenticated plaintext', async () => {
    const encryption = createEncryption();
    const material = encryption.createUploadMaterial(tenantId, documentId);
    const encrypted = encryptForClient(Buffer.from('sensitive'), material.uploadKeyBase64, material.nonceBase64, material.additionalDataBase64);
    encrypted[0] ^= 0xff;

    await expect(collect(encryption.decryptStream({
      tenantId, documentId, wrappedDataKey: material.wrappedDataKey, nonceBase64: material.nonceBase64,
      keyVersion: material.keyVersion, additionalDataBase64: material.additionalDataBase64,
    }, chunks(encrypted)))).rejects.toBeInstanceOf(DocumentEncryptionError);
  });

  it('binds the wrapped key to its tenant and document', () => {
    const encryption = createEncryption();
    const material = encryption.createUploadMaterial(tenantId, documentId);

    expect(() => encryption.decryptStream({
      tenantId, documentId: '00000000-0000-4000-8000-000000000032', wrappedDataKey: material.wrappedDataKey,
      nonceBase64: material.nonceBase64, keyVersion: material.keyVersion,
      additionalDataBase64: material.additionalDataBase64,
    }, chunks(Buffer.alloc(16)))).toThrow(DocumentEncryptionError);
  });
});

function createEncryption(): DocumentEncryptionService {
  return new DocumentEncryptionService(new ConfigService({
    PII_ENCRYPTION_KEY_BASE64: rootKey.toString('base64'),
    PII_ENCRYPTION_KEY_VERSION: 'v1',
  }));
}

function encryptForClient(plaintext: Buffer, keyBase64: string, nonceBase64: string, aadBase64: string): Buffer {
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(keyBase64, 'base64'), Buffer.from(nonceBase64, 'base64'));
  cipher.setAAD(Buffer.from(aadBase64, 'base64'));
  return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}

async function collect(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function* chunks(value: Buffer): AsyncIterable<Uint8Array> {
  yield value.subarray(0, 3);
  yield value.subarray(3, 8);
  yield value.subarray(8);
}
