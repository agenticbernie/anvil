import { hashIdempotencyRequest, hashLegacyIdempotencyRequest } from '../../cases/idempotency/idempotency-policy.js';
import type { IdempotencyRequestHashes, IdempotencyRequestHasher } from '../idempotency.types.js';

export class HmacIdempotencyRequestHasher implements IdempotencyRequestHasher {
  private readonly currentKey: Buffer;
  private readonly previousKeys: readonly Buffer[];

  constructor(currentKey: Uint8Array, previousKeys: readonly Uint8Array[] = []) {
    this.currentKey = copyKey(currentKey);
    this.previousKeys = previousKeys.map(copyKey);
  }

  hash(method: string, route: string, body: unknown): IdempotencyRequestHashes {
    const requestHash = hashIdempotencyRequest(method, route, body, this.currentKey);
    const acceptedRequestHashes = [
      requestHash,
      ...this.previousKeys.map((key) => hashIdempotencyRequest(method, route, body, key)),
      hashLegacyIdempotencyRequest(method, route, body),
    ];
    return { requestHash, acceptedRequestHashes: [...new Set(acceptedRequestHashes)] };
  }
}

function copyKey(key: Uint8Array): Buffer {
  if (key.byteLength !== 32) throw new TypeError('Idempotency HMAC key must be exactly 32 bytes.');
  return Buffer.from(key);
}
