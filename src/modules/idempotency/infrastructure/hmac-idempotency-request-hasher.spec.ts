import { createHmac } from 'node:crypto';
import { describe, expect, it } from '@jest/globals';
import { hashLegacyIdempotencyRequest } from '../../cases/idempotency/idempotency-policy.js';
import { HmacIdempotencyRequestHasher } from './hmac-idempotency-request-hasher.js';

describe('HmacIdempotencyRequestHasher', () => {
  it('creates the active fingerprint and accepts prior keys plus legacy SHA rows', () => {
    const currentKey = Buffer.alloc(32, 1);
    const previousKey = Buffer.alloc(32, 2);
    const hasher = new HmacIdempotencyRequestHasher(currentKey, [previousKey]);
    const body = { normalizedValue: 101 };
    const normalized = 'PATCH\n/v1/facts/fact-1\n{"normalizedValue":101}';
    const fingerprints = hasher.hash('PATCH', '/v1/facts/fact-1', body);

    expect(fingerprints.requestHash).toBe(createHmac('sha256', currentKey).update(normalized).digest('hex'));
    expect(fingerprints.acceptedRequestHashes).toContain(createHmac('sha256', previousKey).update(normalized).digest('hex'));
    expect(fingerprints.acceptedRequestHashes).toContain(hashLegacyIdempotencyRequest('PATCH', '/v1/facts/fact-1', body));
  });

  it('copies secret key bytes when the hasher is created', () => {
    const key = Buffer.alloc(32, 3);
    const hasher = new HmacIdempotencyRequestHasher(key);
    const beforeMutation = hasher.hash('POST', '/v1/cases', {}).requestHash;
    key.fill(4);

    expect(hasher.hash('POST', '/v1/cases', {}).requestHash).toBe(beforeMutation);
  });

  it('rejects a key that is not exactly 32 bytes', () => {
    expect(() => new HmacIdempotencyRequestHasher(Buffer.alloc(31))).toThrow('exactly 32 bytes');
  });

  it('fails closed when the web module has no active key configured', () => {
    expect(() => new HmacIdempotencyRequestHasher(Buffer.alloc(0))).toThrow('exactly 32 bytes');
  });
});
