import type { Pool } from 'pg';
import type { DocumentReservationMaintenanceRepository, StagingCleanupCandidate } from '../application/document.types.js';

interface ReservationRow extends Record<string, unknown> {
  tenant_id: string;
  document_id: string;
  staging_object_key: string;
  finalized_object_key: string | null;
}

interface FinalizedStagingRow extends Record<string, unknown> {
  tenant_id: string;
  document_id: string;
  staging_object_key: string;
  finalized_cleanup_object_key: string | null;
}

export class PostgresDocumentReservationMaintenanceRepository implements DocumentReservationMaintenanceRepository {
  constructor(private readonly pool: Pool) {}

  async claimExpiredReservations(limit: number): Promise<readonly StagingCleanupCandidate[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new RangeError('Reservation cleanup batch size must be between 1 and 500.');
    }
    return this.withServiceRole(async (client) => {
      const result = await client.query<ReservationRow>(
        'SELECT * FROM public.claim_expired_document_reservations_with_finalized_object($1)',
        [limit],
      );
      // @ts-ignore
      return result.rows.map((row) => ({
        tenantId: row.tenant_id,
        documentId: row.document_id,
        stagingObjectKey: row.staging_object_key,
        ...(row.finalized_object_key ? { finalizedObjectKey: row.finalized_object_key } : {}),
      }));
    });
  }

  async markExpiredReservationCleanupChecked(tenantId: string, documentId: string): Promise<boolean> {
    return this.withServiceRole(async (client) => {
      const result = await client.query(
        `UPDATE public.documents
         SET status = 'failed', staging_cleanup_checked_at = now(), reservation_cleanup_locked_until = NULL,
             finalization_cleanup_pending = (final_object_key IS NOT NULL AND final_object_key <> object_key)
         WHERE tenant_id = $1 AND id = $2 AND status = 'pending_upload' AND reservation_expires_at <= now()`,
        [tenantId, documentId],
      );
      return result.rowCount === 1;
    });
  }

  async claimStagingCleanupRetries(limit: number): Promise<readonly StagingCleanupCandidate[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new RangeError('Staging cleanup retry batch size must be between 1 and 500.');
    }
    return this.withServiceRole(async (client) => {
      const result = await client.query<FinalizedStagingRow>(
        'SELECT * FROM public.claim_document_staging_cleanup_retries_with_finalized_key($1)',
        [limit],
      );
      // @ts-ignore
      return result.rows.map((row: any) => ({
        tenantId: row.tenant_id,
        documentId: row.document_id,
        stagingObjectKey: row.staging_object_key,
        ...(row.finalized_cleanup_object_key ? { finalizedObjectKey: row.finalized_cleanup_object_key } : {}),
      }));
    });
  }

  async markStagingCleanupChecked(tenantId: string, documentId: string): Promise<boolean> {
    return this.withServiceRole(async (client) => {
      const result = await client.query(
        `UPDATE public.documents
         SET staging_cleanup_checked_at = now(), reservation_cleanup_locked_until = NULL
         WHERE tenant_id = $1 AND id = $2 AND reservation_expires_at <= now()
           AND ((final_object_key IS NOT NULL AND final_object_key <> object_key)
             OR (final_object_key IS NULL AND status = 'failed'))`,
        [tenantId, documentId],
      );
      return result.rowCount === 1;
    });
  }

  async purgeOldRateLimitWindows(): Promise<void> {
    await this.withServiceRole(async (client) => {
      await client.query('SELECT public.purge_old_document_upload_limits()');
    });
  }

  private async withServiceRole<T>(work: (client: import('pg').PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let started = false;
    try {
      await client.query('BEGIN');
      started = true;
      await client.query('SET LOCAL ROLE service_role');
      const result = await work(client);
      await client.query('COMMIT');
      started = false;
      return result;
    } catch (error) {
      if (started) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], 'Reservation maintenance and rollback both failed.');
        }
      }
      throw error;
    } finally {
      client.release();
    }
  }
}
