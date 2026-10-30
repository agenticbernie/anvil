import { ConfigService } from '@nestjs/config';
import { describe, expect, it } from '@jest/globals';
import { TenantJsonEncryptionService } from '../../../common/security/tenant-json-encryption.service.js';
import { TenantJsonIdempotencyResponseCipher } from './idempotency-response-cipher.js';

const scope = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  actorId: '00000000-0000-4000-8000-000000000011',
  key: 'fact-update-key-0001',
  requestHash: 'a'.repeat(64),
};

describe('TenantJsonIdempotencyResponseCipher', () => {
  const jsonCipher = new TenantJsonEncryptionService(new ConfigService({
    PII_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 31).toString('base64'),
    PII_ENCRYPTION_KEY_VERSION: 'v1',
  }));
  const cipher = new TenantJsonIdempotencyResponseCipher(jsonCipher);

  it('stores response bodies as encrypted envelopes without plaintext PII', () => {
    const body = { normalizedValue: 'Sensitive Borrower Ltd', rawValue: { taxId: '12-3456789' } };
    const stored = cipher.encrypt(scope, body);

    expect(JSON.stringify(stored)).not.toContain('Sensitive Borrower Ltd');
    expect(JSON.stringify(stored)).not.toContain('12-3456789');
    expect(cipher.isEncryptedResponse(stored)).toBe(true);
  });

  it('round-trips JSONB serialized responses for the same tenant, actor, and key', () => {
    const body = { normalizedValue: 50_000, nested: ['confidential'] };
    const stored = JSON.parse(JSON.stringify(cipher.encrypt(scope, body))) as unknown;

    expect(cipher.decrypt(scope, stored)).toEqual(body);
  });

  it.each([
    ['tenant', { ...scope, tenantId: '00000000-0000-4000-8000-000000000002' }],
    ['actor', { ...scope, actorId: '00000000-0000-4000-8000-000000000012' }],
    ['key', { ...scope, key: 'other-key-0000001' }],
    ['request hash', { ...scope, requestHash: 'b'.repeat(64) }],
  ])('rejects replay under a different %s scope', (_scopeName, otherScope) => {
    const stored = cipher.encrypt(scope, { normalizedValue: 'private' });
    expect(() => cipher.decrypt(otherScope, stored)).toThrow('authentication failed');
  });

  it('rejects legacy plaintext and malformed envelopes instead of replaying them', () => {
    expect(() => cipher.decrypt(scope, { normalizedValue: 'legacy plaintext' })).toThrow('not encrypted');
    expect(() => cipher.decrypt(scope, {
      format: 'anvil.idempotency-response', version: 1, payload: { version: 1 },
    })).toThrow('envelope is invalid');
  });
});
