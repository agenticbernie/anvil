import type { IdempotencyClaimRecord } from '../cases/idempotency/idempotency-policy.js';

export interface IdempotencyScope {
  readonly tenantId: string;
  readonly actorId: string;
  readonly key: string;
  readonly requestHash: string;
  readonly previousRequestHashes?: readonly string[];
}

export interface IdempotencyRequestHashes {
  readonly requestHash: string;
  readonly acceptedRequestHashes: readonly string[];
}

export interface IdempotencyRequestHasher {
  hash(method: string, route: string, body: unknown): IdempotencyRequestHashes;
}

export type IdempotencyAcquireResult =
  | { readonly kind: 'acquired' }
  | { readonly kind: 'existing'; readonly record: IdempotencyClaimRecord };

export interface IdempotencyRepository {
  acquire(scope: IdempotencyScope, expiresAt: string): Promise<IdempotencyAcquireResult>;
  complete(scope: IdempotencyScope, status: number, body: unknown): Promise<void>;
  release(scope: IdempotencyScope): Promise<void>;
}

export interface IdempotencyResponseCipher {
  encrypt(scope: IdempotencyScope, body: unknown): Readonly<Record<string, unknown>>;
  decrypt(scope: IdempotencyScope, storedBody: unknown): unknown;
  isEncryptedResponse(storedBody: unknown): boolean;
}
