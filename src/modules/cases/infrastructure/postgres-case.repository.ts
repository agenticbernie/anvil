import { ConflictException, ForbiddenException } from '@nestjs/common';
import type { TenantTransaction } from '../../../infrastructure/database/tenant-transaction.js';
import type { CaseCreationUsage, CaseListOptions, CaseListResult, CaseRepository, CaseStatus, CreateCaseRecord, CreditCase } from '../application/case.types.js';

interface CaseRow extends Record<string, unknown> {
  id: string; tenant_id: string; entity_id: string; case_number: string; status: CaseStatus; currency: string;
  version: number; created_at: Date | string; updated_at: Date | string; deleted_at: Date | string | null;
  current_job_id?: string | null;
}

export class PostgresCaseRepository implements CaseRepository {
  async findById(tenantId: string, actorId: string, caseId: string, transaction: TenantTransaction): Promise<CreditCase | null> {
    const result = await transaction.query<CaseRow>(
      `SELECT c.id, c.tenant_id, c.entity_id, c.case_number, c.status, c.currency, c.version, c.created_at, c.updated_at, c.deleted_at,
              current_job.id AS current_job_id
       FROM public.credit_cases c
       LEFT JOIN LATERAL (
         SELECT j.id FROM public.processing_jobs j
         WHERE j.tenant_id = c.tenant_id AND j.case_id = c.id
         ORDER BY j.created_at DESC, j.id DESC LIMIT 1
       ) current_job ON true
       WHERE c.tenant_id = $1 AND $2::uuid = (SELECT auth.uid()) AND c.id = $3 AND c.deleted_at IS NULL`,
      [tenantId, actorId, caseId],
    );
    return result.rows[0] ? toDomain(result.rows[0]) : null;
  }

  async findByTenant(tenantId: string, actorId: string, options: CaseListOptions, transaction: TenantTransaction): Promise<CaseListResult> {
    const cursorClause = options.cursor ? 'AND (c.created_at, c.id) < ($3::timestamptz, $4::uuid)' : '';
    const values: unknown[] = options.cursor
      ? [tenantId, actorId, options.cursor.createdAt, options.cursor.id, options.limit + 1]
      : [tenantId, actorId, options.limit + 1];
    const limitPlaceholder = options.cursor ? '$5' : '$3';
    const result = await transaction.query<CaseRow>(
      `SELECT c.id, c.tenant_id, c.entity_id, c.case_number, c.status, c.currency, c.version, c.created_at, c.updated_at, c.deleted_at,
              current_job.id AS current_job_id
       FROM public.credit_cases c
       LEFT JOIN LATERAL (
         SELECT j.id FROM public.processing_jobs j
         WHERE j.tenant_id = c.tenant_id AND j.case_id = c.id
         ORDER BY j.created_at DESC, j.id DESC LIMIT 1
       ) current_job ON true
       WHERE c.tenant_id = $1 AND $2::uuid = (SELECT auth.uid()) AND c.deleted_at IS NULL ${cursorClause}
       ORDER BY c.created_at DESC, c.id DESC LIMIT ${limitPlaceholder}`,
      values,
    );
    return { records: result.rows.map(toDomain), hasMore: result.rows.length > options.limit };
  }

  async lockAndGetCreationUsage(tenantId: string, actorId: string, transaction: TenantTransaction): Promise<CaseCreationUsage> {
    // Keep the counters and inserts serialized for this tenant across all API instances.
    await transaction.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`case-creation:${tenantId}`]);
    const hourly = await transaction.query<{ actor_count: number | string; tenant_count: number | string }>(
      `SELECT count(*) FILTER (WHERE actor_id = $2::uuid) AS actor_count,
              count(*) AS tenant_count
       FROM public.audit_events
       WHERE tenant_id = $1 AND event_type = 'case.created' AND created_at >= now() - interval '1 hour'`,
      [tenantId, actorId],
    );
    const lifetime = await transaction.query<{ total_count: number | string }>(
      'SELECT count(*) AS total_count FROM public.credit_cases WHERE tenant_id = $1',
      [tenantId],
    );
    return {
      actorHourlyCreates: Number(hourly.rows[0]?.actor_count ?? 0),
      tenantHourlyCreates: Number(hourly.rows[0]?.tenant_count ?? 0),
      tenantLifetimeCases: Number(lifetime.rows[0]?.total_count ?? 0),
    };
  }

  async create(tenantId: string, actorId: string, input: CreateCaseRecord, transaction: TenantTransaction): Promise<CreditCase> {
    return transaction.withBackendRole(async (backendTransaction) => {
      const result = await backendTransaction.query<CaseRow>(
        `INSERT INTO public.credit_cases (tenant_id, entity_id, case_number, status, currency)
         SELECT $1, $3, $4, $5, $6 WHERE $2::uuid = (SELECT auth.uid())
         RETURNING id, tenant_id, entity_id, case_number, status, currency, version, created_at, updated_at, deleted_at`,
        [tenantId, actorId, input.entityId, input.caseNumber, input.status, input.currency],
      );
      if (!result.rows[0]) throw new ForbiddenException('Actor does not match the authenticated database principal.');
      return toDomain(result.rows[0]);
    });
  }

  async updateStatus(tenantId: string, actorId: string, caseId: string, expectedVersion: number, status: CaseStatus, transaction: TenantTransaction): Promise<CreditCase> {
    return transaction.withBackendRole(async (backendTransaction) => {
      const result = await backendTransaction.query<CaseRow>(
        `UPDATE public.credit_cases SET status = $5, version = version + 1, updated_at = now()
         WHERE tenant_id = $1 AND $2::uuid = (SELECT auth.uid()) AND id = $3 AND version = $4 AND deleted_at IS NULL
         RETURNING id, tenant_id, entity_id, case_number, status, currency, version, created_at, updated_at, deleted_at`,
        [tenantId, actorId, caseId, expectedVersion, status],
      );
      if (!result.rows[0]) throw new ConflictException('Credit case changed before the update could be applied.');
      return toDomain(result.rows[0]);
    });
  }

  async softDelete(tenantId: string, actorId: string, caseId: string, expectedVersion: number, transaction: TenantTransaction): Promise<CreditCase> {
    return transaction.withBackendRole(async (backendTransaction) => {
      const result = await backendTransaction.query<CaseRow>(
        `UPDATE public.credit_cases SET status = 'archived', deleted_at = now(), version = version + 1, updated_at = now()
         WHERE tenant_id = $1 AND $2::uuid = (SELECT auth.uid()) AND id = $3 AND version = $4 AND deleted_at IS NULL
         RETURNING id, tenant_id, entity_id, case_number, status, currency, version, created_at, updated_at, deleted_at`,
        [tenantId, actorId, caseId, expectedVersion],
      );
      if (!result.rows[0]) throw new ConflictException('Credit case changed before it could be archived.');
      return toDomain(result.rows[0]);
    });
  }
}

function toDomain(row: CaseRow): CreditCase {
  const creditCase: CreditCase = {
    id: row.id, tenantId: row.tenant_id, entityId: row.entity_id, caseNumber: row.case_number,
    status: row.status, currency: row.currency.trim(), version: row.version,
    createdAt: asIsoString(row.created_at), updatedAt: asIsoString(row.updated_at),
    deletedAt: row.deleted_at === null ? null : asIsoString(row.deleted_at),
  };
  return row.status === 'processing' && row.current_job_id
    ? { ...creditCase, currentJobId: row.current_job_id }
    : creditCase;
}

function asIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
