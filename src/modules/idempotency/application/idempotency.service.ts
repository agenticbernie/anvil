import { Injectable } from '@nestjs/common';
import type { IdempotencyDecision } from '../../cases/idempotency/idempotency-policy.js';
import { classifyIdempotencyClaim } from '../../cases/idempotency/idempotency-policy.js';
import type { IdempotencyRepository, IdempotencyRequestHasher, IdempotencyScope } from '../idempotency.types.js';

export interface IdempotencyRequest {
  readonly tenantId: string;
  readonly actorId: string;
  readonly key: string;
  readonly method: string;
  readonly route: string;
  readonly body: unknown;
}

export type IdempotencyStart =
  | { readonly kind: 'execute'; readonly scope: IdempotencyScope }
  | { readonly kind: 'replay'; readonly status: number; readonly body: unknown };

@Injectable()
export class IdempotencyService {
  constructor(
    private readonly repository: IdempotencyRepository,
    private readonly requestHasher: IdempotencyRequestHasher,
  ) {}

  async begin(input: IdempotencyRequest): Promise<IdempotencyStart> {
    const fingerprints = this.requestHasher.hash(input.method, input.route, input.body);
    const scope: IdempotencyScope = {
      tenantId: input.tenantId,
      actorId: input.actorId,
      key: input.key,
      requestHash: fingerprints.requestHash,
      previousRequestHashes: fingerprints.acceptedRequestHashes.filter((hash) => hash !== fingerprints.requestHash),
    };
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const acquisition = await this.repository.acquire(scope, expiresAt);
    if (acquisition.kind === 'acquired') return { kind: 'execute', scope };
    const decision = classifyIdempotencyClaim(acquisition.record, fingerprints.acceptedRequestHashes);
    return decision.kind === 'execute' ? { kind: 'execute', scope } : decision;
  }

  complete(scope: IdempotencyScope, status: number, body: unknown): Promise<void> {
    return this.repository.complete(scope, status, body);
  }

  release(scope: IdempotencyScope): Promise<void> {
    return this.repository.release(scope);
  }
}
