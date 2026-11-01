import { ForbiddenException, InternalServerErrorException } from '@nestjs/common';
import type { UnitOfWork } from '../../../infrastructure/database/tenant-transaction.js';
import type { IdempotencyAcquireResult, IdempotencyRepository, IdempotencyResponseCipher, IdempotencyScope } from '../idempotency.types.js';

interface IdempotencyRow extends Record<string, unknown> {
  request_hash: string;
  response_status: number | null;
  response_body: unknown;
  expires_at: Date | string;
}

export class PostgresIdempotencyRepository implements IdempotencyRepository {
  constructor(private readonly unitOfWork: UnitOfWork, private readonly responseCipher: IdempotencyResponseCipher) {}

  async acquire(scope: IdempotencyScope, expiresAt: string): Promise<IdempotencyAcquireResult> {
    return this.unitOfWork.run(scope, (transaction) => transaction.withBackendRole(async (backendTransaction) => {
      await backendTransaction.query(
        `WITH expired_keys AS (
           SELECT idempotency_key
           FROM public.idempotency_keys
           WHERE tenant_id = $1 AND actor_id = $2
             AND $2::uuid = NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid AND expires_at <= now()
           ORDER BY expires_at
           LIMIT 100
           FOR UPDATE SKIP LOCKED
         )
         DELETE FROM public.idempotency_keys AS expired
         USING expired_keys
         WHERE expired.tenant_id = $1 AND expired.actor_id = $2
           AND expired.actor_id = NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
           AND expired.idempotency_key = expired_keys.idempotency_key`,
        [scope.tenantId, scope.actorId],
      );

      const inserted = await backendTransaction.query(
        `INSERT INTO public.idempotency_keys (tenant_id, actor_id, idempotency_key, request_hash, expires_at)
         SELECT $1, $2, $3, $4, $5 WHERE $2::uuid = NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
         ON CONFLICT (tenant_id, actor_id, idempotency_key) DO NOTHING
         RETURNING idempotency_key`,
        [scope.tenantId, scope.actorId, scope.key, scope.requestHash, expiresAt],
      );
      if (inserted.rowCount === 1) return { kind: 'acquired' };

      const selected = await backendTransaction.query<IdempotencyRow>(
        `SELECT request_hash, response_status, response_body, expires_at
         FROM public.idempotency_keys
         WHERE tenant_id = $1 AND actor_id = $2 AND idempotency_key = $3
           AND actor_id = NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
         FOR UPDATE`,
        [scope.tenantId, scope.actorId, scope.key],
      );
      const current = selected.rows[0];
      if (!current) throw new ForbiddenException('Idempotency record is outside the authenticated tenant scope.');

      if (new Date(current.expires_at).getTime() <= Date.now()) {
        const renewed = await backendTransaction.query(
          `UPDATE public.idempotency_keys
           SET request_hash = $4, response_status = NULL, response_body = NULL, created_at = now(), expires_at = $5
           WHERE tenant_id = $1 AND actor_id = $2 AND idempotency_key = $3
             AND actor_id = NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid AND expires_at <= now()`,
          [scope.tenantId, scope.actorId, scope.key, scope.requestHash, expiresAt],
        );
        if (renewed.rowCount !== 1) throw new InternalServerErrorException('Expired idempotency record could not be renewed.');
        return { kind: 'acquired' };
      }

      const acceptedHashes = new Set([scope.requestHash, ...(scope.previousRequestHashes ?? [])]);
      const requestMatches = acceptedHashes.has(current.request_hash);

      return {
        kind: 'existing',
        record: {
          requestHash: current.request_hash,
          responseStatus: current.response_status,
          responseBody: current.response_status === null || !requestMatches
            ? current.response_body
            : this.responseCipher.decrypt({ ...scope, requestHash: current.request_hash }, current.response_body),
          expiresAt: asIsoString(current.expires_at),
        },
      };
    }));
  }

  async complete(scope: IdempotencyScope, status: number, body: unknown): Promise<void> {
    const encryptedBody = this.responseCipher.encrypt(scope, body ?? null);
    await this.unitOfWork.run(scope, (transaction) => transaction.withBackendRole(async (backendTransaction) => {
      const result = await backendTransaction.query(
        `UPDATE public.idempotency_keys SET response_status = $5, response_body = $6::jsonb
         WHERE tenant_id = $1 AND actor_id = $2 AND idempotency_key = $3 AND request_hash = $4
           AND actor_id = NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid AND response_status IS NULL AND expires_at > now()`,
        [scope.tenantId, scope.actorId, scope.key, scope.requestHash, status, JSON.stringify(encryptedBody)],
      );
      if (result.rowCount !== 1) throw new InternalServerErrorException('Idempotency response could not be committed.');
    }));
  }

  async release(scope: IdempotencyScope): Promise<void> {
    await this.unitOfWork.run(scope, (transaction) => transaction.withBackendRole(async (backendTransaction) => {
      await backendTransaction.query(
        `DELETE FROM public.idempotency_keys
         WHERE tenant_id = $1 AND actor_id = $2 AND idempotency_key = $3 AND request_hash = $4
           AND actor_id = NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid AND response_status IS NULL`,
        [scope.tenantId, scope.actorId, scope.key, scope.requestHash],
      );
    }));
  }
}

function asIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
