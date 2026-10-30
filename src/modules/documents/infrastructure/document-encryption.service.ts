import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  DocumentEncryptionContext,
  DocumentEncryptionMaterial,
  DocumentEncryptionProvider,
} from '../application/document.types.js';

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const ALGORITHM = 'aes-256-gcm';

export class DocumentEncryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocumentEncryptionError';
  }
}

@Injectable()
export class DocumentEncryptionService implements DocumentEncryptionProvider {
  constructor(private readonly config: ConfigService) {}

  createUploadMaterial(tenantId: string, documentId: string): DocumentEncryptionMaterial {
    const keyVersion = this.keyVersion;
    const rootKey = this.rootKey;
    const dataKey = randomBytes(KEY_BYTES);
    const dataNonce = randomBytes(NONCE_BYTES);
    const wrapNonce = randomBytes(NONCE_BYTES);
    const documentAad = this.documentAad(tenantId, documentId, keyVersion);
    const wrapper = createCipheriv(ALGORITHM, rootKey, wrapNonce);
    wrapper.setAAD(Buffer.concat([documentAad, Buffer.from(':wrapped-key')]));
    const wrappedBytes = Buffer.concat([wrapper.update(dataKey), wrapper.final(), wrapper.getAuthTag()]);

    return {
      uploadKeyBase64: dataKey.toString('base64'),
      nonceBase64: dataNonce.toString('base64'),
      additionalDataBase64: documentAad.toString('base64'),
      wrappedDataKey: `${keyVersion}.${wrapNonce.toString('base64')}.${wrappedBytes.toString('base64')}`,
      keyVersion,
    };
  }

  decryptStream(context: DocumentEncryptionContext, source: AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array> {
    const dataKey = this.unwrapDataKey(context);
    const nonce = decodeBase64(context.nonceBase64, NONCE_BYTES, 'document nonce');
    const additionalData = decodeBase64(context.additionalDataBase64, undefined, 'document additional data');
    const expectedAad = this.documentAad(context.tenantId, context.documentId, context.keyVersion);
    if (!additionalData.equals(expectedAad)) throw new DocumentEncryptionError('Document encryption context is invalid.');
    return decryptAesGcmStream(source, dataKey, nonce, additionalData);
  }

  private unwrapDataKey(context: DocumentEncryptionContext): Buffer {
    const [envelopeVersion, encodedNonce, encodedCiphertext, extra] = context.wrappedDataKey.split('.');
    if (extra !== undefined || envelopeVersion !== context.keyVersion || envelopeVersion !== this.keyVersion) {
      throw new DocumentEncryptionError('Document encryption key version is not supported.');
    }
    const nonce = decodeBase64(encodedNonce ?? '', NONCE_BYTES, 'wrapped-key nonce');
    const ciphertextAndTag = decodeBase64(encodedCiphertext ?? '', KEY_BYTES + TAG_BYTES, 'wrapped data key');
    const decipher = createDecipheriv(ALGORITHM, this.rootKey, nonce);
    const aad = this.documentAad(context.tenantId, context.documentId, context.keyVersion);
    decipher.setAAD(Buffer.concat([aad, Buffer.from(':wrapped-key')]));
    decipher.setAuthTag(ciphertextAndTag.subarray(KEY_BYTES));
    try {
      const key = Buffer.concat([decipher.update(ciphertextAndTag.subarray(0, KEY_BYTES)), decipher.final()]);
      if (key.length !== KEY_BYTES) throw new DocumentEncryptionError('Wrapped data key is invalid.');
      return key;
    } catch {
      throw new DocumentEncryptionError('Wrapped data key authentication failed.');
    }
  }

  private documentAad(tenantId: string, documentId: string, keyVersion: string): Buffer {
    return Buffer.from(`anvil.document:${tenantId}:${documentId}:${keyVersion}`, 'utf8');
  }

  private get keyVersion(): string {
    return this.config.get<string>('PII_ENCRYPTION_KEY_VERSION', 'v1');
  }

  private get rootKey(): Buffer {
    const encodedKey = this.config.get<string>('PII_ENCRYPTION_KEY_BASE64', '');
    const key = Buffer.from(encodedKey, 'base64');
    if (key.length !== KEY_BYTES || key.toString('base64') !== encodedKey) {
      throw new ServiceUnavailableException('Document encryption is not configured with a valid 32-byte key.');
    }
    return key;
  }
}

async function* decryptAesGcmStream(
  source: AsyncIterable<Uint8Array>,
  key: Buffer,
  nonce: Buffer,
  additionalData: Buffer,
): AsyncIterable<Uint8Array> {
  const decipher = createDecipheriv(ALGORITHM, key, nonce);
  decipher.setAAD(additionalData);
  let tail = Buffer.alloc(0);

  for await (const chunk of source) {
    const combined = Buffer.concat([tail, Buffer.from(chunk)]);
    if (combined.length <= TAG_BYTES) {
      tail = combined;
      continue;
    }
    const ciphertextLength = combined.length - TAG_BYTES;
    const plaintext = decipher.update(combined.subarray(0, ciphertextLength));
    tail = combined.subarray(ciphertextLength);
    if (plaintext.length > 0) yield plaintext;
  }

  if (tail.length !== TAG_BYTES) throw new DocumentEncryptionError('Encrypted document is truncated.');
  decipher.setAuthTag(tail);
  try {
    const final = decipher.final();
    if (final.length > 0) yield final;
  } catch {
    throw new DocumentEncryptionError('Encrypted document authentication failed.');
  }
}

function decodeBase64(value: string, expectedBytes: number | undefined, label: string): Buffer {
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value || (expectedBytes !== undefined && decoded.length !== expectedBytes)) {
    throw new DocumentEncryptionError(`${label} is invalid.`);
  }
  return decoded;
}
