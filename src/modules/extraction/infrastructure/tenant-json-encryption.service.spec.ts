import { ConfigService } from '@nestjs/config';
import { describe, expect, it } from '@jest/globals';
import { TenantJsonEncryptionService } from './tenant-json-encryption.service.js';

describe('TenantJsonEncryptionService', () => {
  const tenantId = '00000000-0000-4000-8000-000000000001';
  const factId = '00000000-0000-4000-8000-000000000011';
  const cipher = new TenantJsonEncryptionService(new ConfigService({ PII_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 6).toString('base64'), PII_ENCRYPTION_KEY_VERSION: 'v1' }));

  it('encrypts fact values at rest and decrypts only for the matching tenant/fact/field', () => {
    const value = { amount: 50_000, currency: 'USD' };
    const envelope = cipher.encrypt(tenantId, factId, 'normalized_value', value);
    expect(JSON.stringify(envelope)).not.toContain('50000');
    expect(cipher.decrypt(tenantId, factId, 'normalized_value', envelope)).toEqual(value);
  });

  it('survives JSONB serialization of the envelope', () => {
    const value = ['private', 50_000];
    const envelope = JSON.parse(JSON.stringify(cipher.encrypt(tenantId, factId, 'raw_value', value))) as unknown;
    expect(cipher.decrypt(tenantId, factId, 'raw_value', envelope)).toEqual(value);
  });

  it('authenticates the envelope against the resource and field names', () => {
    const envelope = cipher.encrypt(tenantId, factId, 'raw_value', 'USD 50,000');
    expect(() => cipher.decrypt(tenantId, factId, 'normalized_value', envelope)).toThrow('authentication failed');
  });

  it('rejects malformed envelopes rather than treating them as plaintext', () => {
    expect(() => cipher.decrypt(tenantId, factId, 'raw_value', { raw: 'PII' })).toThrow('envelope is invalid');
  });

  it('creates stable tenant-scoped HMAC fingerprints instead of exposing low-entropy PII hashes', () => {
    const snapshot = { revenue: 50_000 };
    const first = cipher.fingerprint(tenantId, factId, 'memo-input', snapshot);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(cipher.fingerprint(tenantId, factId, 'memo-input', snapshot)).toBe(first);
    expect(cipher.fingerprint('00000000-0000-4000-8000-000000000099', factId, 'memo-input', snapshot)).not.toBe(first);
  });
});
