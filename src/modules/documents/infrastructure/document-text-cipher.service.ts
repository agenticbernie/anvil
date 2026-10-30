import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { DocumentTextCipher } from '../application/document.types.js';

@Injectable()
export class DocumentTextCipherService implements DocumentTextCipher {
  constructor(private readonly config: ConfigService) {}

  encrypt(tenantId: string, documentVersionId: string, plaintext: string) {
    const nonce = randomBytes(12);
    const keyVersion = this.config.get<string>('PII_ENCRYPTION_KEY_VERSION', 'v1');
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(aad(tenantId, documentVersionId, keyVersion));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()]);
    return { ciphertext, nonce, keyVersion };
  }

  decrypt(tenantId: string, documentVersionId: string, ciphertext: Uint8Array, nonce: Uint8Array, keyVersion: string): string {
    if (keyVersion !== this.config.get<string>('PII_ENCRYPTION_KEY_VERSION', 'v1') || nonce.byteLength !== 12 || ciphertext.byteLength < 16) {
      throw new Error('Document text encryption metadata is invalid.');
    }
    const input = Buffer.from(ciphertext);
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(nonce));
    decipher.setAAD(aad(tenantId, documentVersionId, keyVersion));
    decipher.setAuthTag(input.subarray(input.length - 16));
    try { return Buffer.concat([decipher.update(input.subarray(0, -16)), decipher.final()]).toString('utf8'); }
    catch { throw new Error('Document text authentication failed.'); }
  }

  private get key(): Buffer {
    const encoded = this.config.get<string>('PII_ENCRYPTION_KEY_BASE64', '');
    const key = Buffer.from(encoded, 'base64');
    if (key.length !== 32 || key.toString('base64') !== encoded) throw new ServiceUnavailableException('PII encryption key is not configured.');
    return key;
  }
}

function aad(tenantId: string, documentVersionId: string, keyVersion: string): Buffer {
  return Buffer.from(`anvil.document-text:${tenantId}:${documentVersionId}:${keyVersion}`);
}
