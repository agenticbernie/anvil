import { ConflictException, ForbiddenException, HttpException, HttpStatus } from '@nestjs/common';
import type { Pool } from 'pg';
import type { TenantTransaction } from '../../../infrastructure/database/tenant-transaction.js';
import type { OutboxEvent, OutboxEventPayload, OutboxEventType, OutboxRepository } from '../application/document.types.js';

interface OutboxRow extends Record<string, unknown> {
  event_id: string; tenant_id: string; actor_id: string; event_type: OutboxEventType;
  payload: OutboxEventPayload | string; publish_attempts: number;
}

export class PostgresOutboxRepository implements OutboxRepository {
  constructor(private readonly pool: Pool) {}

  async create(tenantId: string, actorId: string, eventType: OutboxEventType, payload: OutboxEventPayload, transaction: TenantTransaction): Promise<void> {
    await transaction.withBackendRole(async (tx) => {
      if (eventType === 'memo.generate.requested') await this.enforceMemoGenerationBudget(tenantId, actorId, tx);
      const result = await tx.query(
        `INSERT INTO public.outbox_events (tenant_id, actor_id, event_type, payload)
         SELECT $1, $2, $3, $4::jsonb WHERE $2::uuid = (SELECT auth.uid())`,
        [tenantId, actorId, eventType, JSON.stringify(payload)],
      );
      if (result.rowCount !== 1) throw new ForbiddenException('Actor does not match the authenticated database principal.');
    });
  }

  private async enforceMemoGenerationBudget(tenantId: string, actorId: string, tx: TenantTransaction): Promise<void> {
    // Serialize budget checks per tenant so concurrent web instances cannot race past either limit.
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`memo-generation:${tenantId}`]);
    const result = await tx.query<{ actor_count: number | string; tenant_count: number | string; lifetime_count: number | string }>(
      `SELECT count(*) FILTER (WHERE actor_id = $2::uuid AND created_at >= now() - interval '1 hour')::int AS actor_count,
              count(*) FILTER (WHERE created_at >= now() - interval '1 hour')::int AS tenant_count,
              count(*)::int AS lifetime_count
       FROM public.outbox_events
       WHERE tenant_id = $1 AND event_type = 'memo.generate.requested'`,
      [tenantId, actorId],
    );
    if (Number(result.rows[0]?.actor_count ?? 0) >= 10 || Number(result.rows[0]?.tenant_count ?? 0) >= 100) {
      throw new HttpException('Memo generation request rate limit exceeded.', HttpStatus.TOO_MANY_REQUESTS);
    }
    if (Number(result.rows[0]?.lifetime_count ?? 0) >= 100_000) {
      throw new ConflictException('Tenant memo generation lifetime request limit has been reached.');
    }
  }

  async claimPending(limit: number): Promise<readonly OutboxEvent[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError('Outbox batch size must be between 1 and 100.');
    const client = await this.pool.connect();
    let started = false;
    try {
      await client.query('BEGIN');
      started = true;
      await client.query('SET LOCAL ROLE service_role');
      const result = await client.query<OutboxRow>(
        'SELECT * FROM public.claim_pending_outbox_events($1)',
        [limit],
      );
      await client.query('COMMIT');
      started = false;
      return result.rows.map(toEvent);
    } catch (error) {
      if (started) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], 'Outbox claim and rollback both failed.');
        }
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async markPublished(tenantId: string, actorId: string, eventId: string, transaction: TenantTransaction): Promise<void> {
    await transaction.withBackendRole(async (tx) => {
      const result = await tx.query(
        `UPDATE public.outbox_events SET status = 'published', published_at = now(), locked_until = NULL, last_error = NULL
         WHERE tenant_id = $1 AND $2::uuid = (SELECT auth.uid()) AND actor_id = $2 AND id = $3 AND status = 'publishing'`,
        [tenantId, actorId, eventId],
      );
      if (result.rowCount !== 1) throw new ConflictException('Outbox event lease is no longer active.');
    });
  }

  async retryOrDeadLetter(tenantId: string, actorId: string, event: OutboxEvent, errorMessage: string, transaction: TenantTransaction): Promise<void> {
    await transaction.withBackendRole(async (tx) => {
      const result = await tx.query(
        `UPDATE public.outbox_events
         SET status = CASE WHEN publish_attempts >= 10 THEN 'dead_lettered' ELSE 'pending' END,
             available_at = now() + make_interval(secs => LEAST(power(2, publish_attempts)::integer, 300)),
             locked_until = NULL, last_error = $4
         WHERE tenant_id = $1 AND $2::uuid = (SELECT auth.uid()) AND actor_id = $2 AND id = $3 AND status = 'publishing'`,
        [tenantId, actorId, event.id, errorMessage.slice(0, 500)],
      );
      if (result.rowCount !== 1) throw new ConflictException('Outbox event could not be released for retry.');
    });
  }
}

function toEvent(row: OutboxRow): OutboxEvent {
  const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) as unknown : row.payload;
  if (!isPayload(payload, row.event_type)) throw new TypeError(`Outbox event ${row.event_id} has an invalid payload.`);
  return {
    id: row.event_id,
    tenantId: row.tenant_id,
    actorId: row.actor_id,
    eventType: row.event_type,
    payload,
    publishAttempts: row.publish_attempts,
  };
}

function isPayload(value: unknown, type: OutboxEventType): value is OutboxEventPayload {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  if (!isUuid(candidate.caseId)) return false;
  switch (type) {
    case 'document.uploaded':
    case 'document.parse.dead_lettered': return isUuid(candidate.processingJobId) && isUuid(candidate.documentId);
    case 'document.extract.requested': return isUuid(candidate.processingJobId) && isUuid(candidate.documentId) && isUuid(candidate.documentVersionId);
    case 'extraction.needs_manual_review': return isUuid(candidate.documentId) && isUuid(candidate.extractionRunId);
    case 'memo.generate.requested':
      return isUuid(candidate.generationKey)
        && (candidate.overrideReasonCiphertext === undefined || isEncryptedEnvelope(candidate.overrideReasonCiphertext));
  }
}

function isEncryptedEnvelope(value: unknown): value is Readonly<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const envelope = value as Record<string, unknown>;
  return envelope.version === 1 && typeof envelope.keyVersion === 'string'
    && typeof envelope.nonce === 'string' && typeof envelope.ciphertext === 'string';
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
