import { BadRequestException, ConflictException } from '@nestjs/common';
import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from '@jest/globals';
import { classifyIdempotencyClaim, hashIdempotencyRequest } from './idempotency-policy.js';

describe('idempotency policy', () => {
  it('executes a request when no unexpired key exists', () => {
    expect(classifyIdempotencyClaim(null, 'hash-a')).toEqual({ kind: 'execute' });
  });

  it('replays a completed response for the same hash', () => {
    expect(classifyIdempotencyClaim({ requestHash: 'hash-a', responseStatus: 201, responseBody: { id: 'case-1' }, expiresAt: '2099-01-01T00:00:00Z' }, 'hash-a'))
      .toEqual({ kind: 'replay', status: 201, body: { id: 'case-1' } });
  });

  it('rejects reuse of an idempotency key with a different request hash', () => {
    expect(() => classifyIdempotencyClaim({ requestHash: 'hash-a', responseStatus: 201, responseBody: {}, expiresAt: '2099-01-01T00:00:00Z' }, 'hash-b'))
      .toThrow(ConflictException);
  });

  it('rejects an in-progress duplicate instead of executing it twice', () => {
    expect(() => classifyIdempotencyClaim({ requestHash: 'hash-a', responseStatus: null, responseBody: null, expiresAt: '2099-01-01T00:00:00Z' }, 'hash-a'))
      .toThrow(ConflictException);
  });

  it('allows a key to be claimed again after its retention period expires', () => {
    expect(classifyIdempotencyClaim({ requestHash: 'old-hash', responseStatus: 201, responseBody: {}, expiresAt: '2020-01-01T00:00:00Z' }, 'new-hash', new Date('2026-10-29T00:00:00Z')))
      .toEqual({ kind: 'execute' });
  });

  it('hashes JSON bodies canonically regardless of object key order', () => {
    const key = Buffer.alloc(32, 1);
    expect(hashIdempotencyRequest('POST', '/v1/cases', { entityId: 'e1', amount: 42 }, key))
      .toBe(hashIdempotencyRequest('POST', '/v1/cases', { amount: 42, entityId: 'e1' }, key));
  });

  it('includes method and route in the request hash', () => {
    const key = Buffer.alloc(32, 1);
    const body = { entityId: 'e1' };
    expect(hashIdempotencyRequest('POST', '/v1/cases', body, key)).not.toBe(hashIdempotencyRequest('PATCH', '/v1/cases', body, key));
  });

  it('uses a keyed HMAC so database readers cannot verify guesses with plain SHA-256', () => {
    const body = { normalizedValue: 101 };
    const normalized = 'PATCH\n/v1/facts/fact-1\n{"normalizedValue":101}';
    const currentKey = Buffer.alloc(32, 1);
    const differentKey = Buffer.alloc(32, 2);
    const expected = createHmac('sha256', currentKey).update(normalized, 'utf8').digest('hex');
    const legacy = createHash('sha256').update(normalized, 'utf8').digest('hex');

    expect(hashIdempotencyRequest('PATCH', '/v1/facts/fact-1', body, currentKey)).toBe(expected);
    expect(hashIdempotencyRequest('PATCH', '/v1/facts/fact-1', body, differentKey)).not.toBe(expected);
    expect(hashIdempotencyRequest('PATCH', '/v1/facts/fact-1', body, currentKey)).not.toBe(legacy);
  });

  it('replays a matching legacy fingerprint during the transition window', () => {
    const legacyHash = 'legacy-sha256';
    expect(classifyIdempotencyClaim(
      { requestHash: legacyHash, responseStatus: 200, responseBody: { id: 'fact-1' }, expiresAt: '2099-01-01T00:00:00Z' },
      ['current-hmac', legacyHash],
    )).toEqual({ kind: 'replay', status: 200, body: { id: 'fact-1' } });
  });

  it('rejects request bodies deeper than the canonicalization limit', () => {
    const key = Buffer.alloc(32, 1);
    let body: unknown = {};
    for (let depth = 0; depth < 65; depth += 1) body = { nested: body };
    expect(() => hashIdempotencyRequest('POST', '/v1/cases', body, key)).toThrow(BadRequestException);
  });

  it('rejects request bodies with too many values to hash within a bounded budget', () => {
    const key = Buffer.alloc(32, 1);
    const body = Array.from({ length: 10_001 }, (_, index) => index);
    expect(() => hashIdempotencyRequest('POST', '/v1/cases', body, key)).toThrow(BadRequestException);
  });
});
