import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface EncryptedJsonValue {
  readonly version: 1;
  readonly keyVersion: string;
  readonly nonce: string;
  readonly ciphertext: string;
}

@Injectable()
export class TenantJsonEncryptionService {
  constructor(private readonly config: ConfigService) {}

  encrypt(tenantId: string, resourceId: string, field: string, value: unknown): Readonly<Record<string, unknown>> {
    const plaintext = JSON.stringify(value);
    if (plaintext === undefined) throw new TypeError('Encrypted JSON value is not serializable.');
    const nonce = randomBytes(12);
    const keyVersion = this.config.get<string>('PII_ENCRYPTION_KEY_VERSION', 'v1');
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(aad(tenantId, resourceId, field, keyVersion));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()]);
    return { version: 1, keyVersion, nonce: nonce.toString('base64'), ciphertext: ciphertext.toString('base64') };
  }

  decrypt(tenantId: string, resourceId: string, field: string, value: unknown): unknown {
    const envelope = parseEnvelope(value);
    const expectedVersion = this.config.get<string>('PII_ENCRYPTION_KEY_VERSION', 'v1');
    if (envelope.keyVersion !== expectedVersion) throw new Error('Encrypted JSON key version is unsupported.');
    const nonce = strictBase64(envelope.nonce);
    const ciphertext = strictBase64(envelope.ciphertext);
    if (nonce.length !== 12 || ciphertext.length < 16) throw new Error('Encrypted JSON envelope is invalid.');
    const decipher = createDecipheriv('aes-256-gcm', this.key, nonce);
    decipher.setAAD(aad(tenantId, resourceId, field, envelope.keyVersion));
    decipher.setAuthTag(ciphertext.subarray(-16));
    let plaintext: string;
    try { plaintext = Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]).toString('utf8'); }
    catch (cause) { throw new Error(`Encrypted JSON authentication failed for ${field}.`, { cause }); }
    try { return JSON.parse(plaintext) as unknown; }
    catch (cause) { throw new Error(`Encrypted JSON plaintext is invalid for ${field}.`, { cause }); }
  }

  fingerprint(tenantId: string, resourceId: string, purpose: string, value: unknown): string {
    const keyVersion = this.config.get<string>('PII_ENCRYPTION_KEY_VERSION', 'v1');
    return createHmac('sha256', this.key)
      .update(`anvil.fingerprint:${keyVersion}:${tenantId}:${resourceId}:${purpose}:`)
      .update(JSON.stringify(value) ?? 'null')
      .digest('hex');
  }

  private get key(): Buffer {
    const encoded = this.config.get<string>('PII_ENCRYPTION_KEY_BASE64', '');
    const key = Buffer.from(encoded, 'base64');
    if (key.length !== 32 || key.toString('base64') !== encoded) throw new ServiceUnavailableException('PII encryption key is not configured.');
    return key;
  }
}

function aad(tenantId: string, resourceId: string, field: string, keyVersion: string): Buffer {
  return Buffer.from(`anvil.json:${tenantId}:${resourceId}:${field}:${keyVersion}`);
}

function parseEnvelope(value: unknown): EncryptedJsonValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Encrypted JSON envelope must be an object.');
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== 1 || typeof candidate.keyVersion !== 'string' || typeof candidate.nonce !== 'string' || typeof candidate.ciphertext !== 'string') {
    throw new TypeError('Encrypted JSON envelope is invalid.');
  }
  return { version: 1, keyVersion: candidate.keyVersion, nonce: candidate.nonce, ciphertext: candidate.ciphertext };
}

function strictBase64(value: string): Buffer {
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) throw new TypeError('Encrypted JSON base64 is invalid.');
  return decoded;
}
