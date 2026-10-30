import { ConfigService } from '@nestjs/config';
import { describe, expect, it } from '@jest/globals';
import { DocumentTextCipherService } from './document-text-cipher.service.js';

describe('DocumentTextCipherService', () => {
  const tenantId = '00000000-0000-4000-8000-000000000001';
  const versionId = '00000000-0000-4000-8000-000000000021';
  const cipher = new DocumentTextCipherService(new ConfigService({ PII_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 5).toString('base64'), PII_ENCRYPTION_KEY_VERSION: 'v1' }));

  it('round-trips source text without storing the plaintext in the ciphertext', () => {
    const text = 'Revenue is USD 50,000.';
    const sealed = cipher.encrypt(tenantId, versionId, text);
    expect(Buffer.from(sealed.ciphertext).toString('utf8')).not.toContain(text);
    expect(cipher.decrypt(tenantId, versionId, sealed.ciphertext, sealed.nonce, sealed.keyVersion)).toBe(text);
  });

  it('binds ciphertext to its tenant and document version', () => {
    const sealed = cipher.encrypt(tenantId, versionId, 'Confidential source text');
    expect(() => cipher.decrypt('00000000-0000-4000-8000-000000000099', versionId, sealed.ciphertext, sealed.nonce, sealed.keyVersion)).toThrow('authentication failed');
  });

  it('rejects malformed encryption metadata', () => {
    expect(() => cipher.decrypt(tenantId, versionId, Buffer.from('short'), Buffer.alloc(12), 'v1')).toThrow('metadata is invalid');
  });
});
