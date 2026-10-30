import type { Pool } from 'pg';
import type { IdempotencyResponseCipher, IdempotencyScope } from '../idempotency.types.js';

interface CacheRow extends Record<string, unknown> {
  tenant_id: string;
  actor_id: string;
  idempotency_key: string;
  request_hash: string;
  response_body: unknown;
}

export interface IdempotencyCacheBackfillResult {
  readonly scanned: number;
  readonly encrypted: number;
  readonly alreadyEncrypted: number;
  readonly applied: boolean;
}

export async function backfillIdempotencyResponseCache(
  pool: Pool,
  cipher: IdempotencyResponseCipher,
  apply: boolean,
): Promise<IdempotencyCacheBackfillResult> {
  const client = await pool.connect();
  let transactionStarted = false;
  try {
    await client.query('BEGIN');
    transactionStarted = true;
    await client.query('LOCK TABLE public.idempotency_keys IN SHARE ROW EXCLUSIVE MODE');
    const selected = await client.query<CacheRow>(
      `SELECT tenant_id, actor_id, idempotency_key, request_hash, response_body
       FROM public.idempotency_keys
       WHERE response_body IS NOT NULL
       ORDER BY tenant_id, actor_id, idempotency_key
       FOR UPDATE`,
    );

    let encryptedCount = 0;
    let alreadyEncryptedCount = 0;
    for (const row of selected.rows) {
      const scope: IdempotencyScope = {
        tenantId: row.tenant_id,
        actorId: row.actor_id,
        key: row.idempotency_key,
        requestHash: row.request_hash,
      };
      if (cipher.isEncryptedResponse(row.response_body)) {
        cipher.decrypt(scope, row.response_body);
        alreadyEncryptedCount += 1;
        continue;
      }

      const encryptedBody = cipher.encrypt(scope, row.response_body);
      encryptedCount += 1;
      if (apply) {
        const updated = await client.query(
          `UPDATE public.idempotency_keys SET response_body = $4::jsonb
           WHERE tenant_id = $1 AND actor_id = $2 AND idempotency_key = $3 AND request_hash = $5`,
          [scope.tenantId, scope.actorId, scope.key, JSON.stringify(encryptedBody), scope.requestHash],
        );
        if (updated.rowCount !== 1) throw new Error('An idempotency cache row changed during the locked backfill.');
      }
    }

    if (apply) await client.query('COMMIT');
    else await client.query('ROLLBACK');
    transactionStarted = false;
    return {
      scanned: selected.rows.length,
      encrypted: encryptedCount,
      alreadyEncrypted: alreadyEncryptedCount,
      applied: apply,
    };
  } catch (error) {
    if (transactionStarted) {
      try { await client.query('ROLLBACK'); }
      catch (rollbackError) { throw new AggregateError([error, rollbackError], 'Idempotency cache backfill failed and rollback also failed.'); }
    }
    throw error;
  } finally {
    client.release();
  }
}
