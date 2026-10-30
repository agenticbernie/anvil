import { ConflictException } from '@nestjs/common';
import type { TenantTransaction } from '../../../infrastructure/database/tenant-transaction.js';
import type { BeginJobAttempt, DocumentProcessingErrorCode, ProcessingJobRecord, ProcessingJobRepository, ProcessingJobStatusRecord } from '../application/document.types.js';

interface JobRow extends Record<string, unknown> {
  id: string; tenant_id: string; case_id: string; document_id: string; actor_id: string;
  status: ProcessingJobRecord['status']; attempt_count: number;
}

export class PostgresProcessingJobRepository implements ProcessingJobRepository {
  async create(tenantId: string, actorId: string, caseId: string, documentId: string, transaction: TenantTransaction): Promise<ProcessingJobRecord> {
    return transaction.withBackendRole(async (tx) => {
      const result = await tx.query<JobRow>(
        `INSERT INTO public.processing_jobs (tenant_id, case_id, document_id, actor_id, job_type)
         SELECT $1, $3, $4, $2, 'document.parse' WHERE $2::uuid = (SELECT auth.uid())
         RETURNING id, tenant_id, case_id, document_id, actor_id, status, attempt_count`,
        [tenantId, actorId, caseId, documentId],
      );
      if (!result.rows[0]) throw new ConflictException('Processing job could not be created for this actor.');
      return toJob(result.rows[0]);
    });
  }

  async findForDocument(tenantId: string, actorId: string, documentId: string, transaction: TenantTransaction): Promise<ProcessingJobRecord | null> {
    const result = await transaction.query<JobRow>(
      `SELECT id, tenant_id, case_id, document_id, actor_id, status, attempt_count FROM public.processing_jobs
       WHERE tenant_id = $1 AND actor_id = $2 AND $2::uuid = (SELECT auth.uid()) AND document_id = $3 AND job_type = 'document.parse'`,
      [tenantId, actorId, documentId],
    );
    return result.rows[0] ? toJob(result.rows[0]) : null;
  }

  async findById(tenantId: string, actorId: string, jobId: string, transaction: TenantTransaction): Promise<ProcessingJobStatusRecord | null> {
    const result = await transaction.query<{
      id: string; case_id: string; document_id: string; status: ProcessingJobStatusRecord['status'];
      progress: number; error_code: string | null; attempt_count: number; updated_at: Date | string;
    }>(
      `SELECT id, case_id, document_id, status, progress, error_code, attempt_count, updated_at
       FROM public.processing_jobs
       WHERE tenant_id = $1 AND id = $3 AND $2::uuid = (SELECT auth.uid())`,
      [tenantId, actorId, jobId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const errorCode = isProcessingErrorCode(row.error_code) ? row.error_code : null;
    return {
      id: row.id,
      caseId: row.case_id,
      documentId: row.document_id,
      status: row.status,
      progress: Number(row.progress),
      errorCode,
      attemptCount: Number(row.attempt_count),
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : new Date(row.updated_at).toISOString(),
    };
  }

  async beginAttempt(
    tenantId: string, actorId: string, jobId: string, documentId: string, caseId: string, transaction: TenantTransaction,
  ): Promise<BeginJobAttempt> {
    return transaction.withBackendRole(async (tx) => {
      const updated = await tx.query<JobRow>(
        `UPDATE public.processing_jobs
         SET status = 'processing', attempt_count = attempt_count + 1, progress = GREATEST(progress, 10),
             lock_expires_at = now() + interval '5 minutes', started_at = COALESCE(started_at, now()), updated_at = now()
         WHERE tenant_id = $1 AND actor_id = $2 AND $2::uuid = (SELECT auth.uid()) AND id = $3
           AND document_id = $4 AND case_id = $5
           AND attempt_count < 3
           AND (status IN ('queued', 'retry_wait') OR (status = 'processing' AND lock_expires_at < now()))
         RETURNING id, tenant_id, case_id, document_id, actor_id, status, attempt_count`,
        [tenantId, actorId, jobId, documentId, caseId],
      );
      if (updated.rows[0]) return { acquired: true, completed: false, attemptCount: updated.rows[0].attempt_count };
      const current = await tx.query<JobRow>(
        `SELECT id, tenant_id, case_id, document_id, actor_id, status, attempt_count FROM public.processing_jobs
         WHERE tenant_id = $1 AND actor_id = $2 AND $2::uuid = (SELECT auth.uid()) AND id = $3
           AND document_id = $4 AND case_id = $5`,
        [tenantId, actorId, jobId, documentId, caseId],
      );
      const row = current.rows[0];
      if (!row) throw new ConflictException('Processing job was not found in this tenant.');
      return {
        acquired: false,
        completed: row.status === 'succeeded' || row.status === 'dead_lettered' || row.status === 'failed',
        attemptCount: row.attempt_count,
      };
    });
  }

  async markRetryWait(tenantId: string, actorId: string, jobId: string, code: DocumentProcessingErrorCode, transaction: TenantTransaction): Promise<void> {
    await this.updateFailure(tenantId, actorId, jobId, 'retry_wait', code, transaction);
  }

  async markSucceeded(tenantId: string, actorId: string, jobId: string, workerVersion: string, transaction: TenantTransaction): Promise<void> {
    await transaction.withBackendRole(async (tx) => {
      const result = await tx.query(
        `UPDATE public.processing_jobs SET status = 'succeeded', progress = 100, worker_version = $4,
            error_code = NULL, last_error = NULL, lock_expires_at = NULL, updated_at = now(), completed_at = now()
         WHERE tenant_id = $1 AND actor_id = $2 AND $2::uuid = (SELECT auth.uid()) AND id = $3 AND status = 'processing'`,
        [tenantId, actorId, jobId, workerVersion],
      );
      if (result.rowCount !== 1) throw new ConflictException('Processing job is no longer owned by this attempt.');
    });
  }

  async markDeadLettered(tenantId: string, actorId: string, jobId: string, code: DocumentProcessingErrorCode, transaction: TenantTransaction): Promise<void> {
    await this.updateFailure(tenantId, actorId, jobId, 'dead_lettered', code, transaction);
  }

  private async updateFailure(
    tenantId: string, actorId: string, jobId: string, status: 'retry_wait' | 'dead_lettered', code: DocumentProcessingErrorCode, transaction: TenantTransaction,
  ): Promise<void> {
    await transaction.withBackendRole(async (tx) => {
      const result = await tx.query(
        `UPDATE public.processing_jobs SET status = $4, error_code = $5, last_error = $6,
            lock_expires_at = NULL, updated_at = now(), completed_at = CASE WHEN $4 = 'dead_lettered' THEN now() ELSE NULL END
         WHERE tenant_id = $1 AND actor_id = $2 AND $2::uuid = (SELECT auth.uid()) AND id = $3 AND status = 'processing'`,
        [tenantId, actorId, jobId, status, code, safeProcessingErrorMessage(code)],
      );
      if (result.rowCount !== 1) throw new ConflictException('Processing job is no longer owned by this attempt.');
    });
  }
}

function safeProcessingErrorMessage(code: DocumentProcessingErrorCode): string {
  switch (code) {
    case 'DOCUMENT_CHECKSUM_MISMATCH': return 'The uploaded document failed integrity verification.';
    case 'DOCUMENT_ENCRYPTION_FAILED': return 'The uploaded document could not be decrypted.';
    case 'DOCUMENT_PARSE_FAILED': return 'Document processing failed.';
  }
}

function isProcessingErrorCode(value: string | null): value is DocumentProcessingErrorCode {
  return value === 'DOCUMENT_CHECKSUM_MISMATCH'
    || value === 'DOCUMENT_ENCRYPTION_FAILED'
    || value === 'DOCUMENT_PARSE_FAILED';
}

function toJob(row: JobRow): ProcessingJobRecord {
  return {
    id: row.id, tenantId: row.tenant_id, caseId: row.case_id, documentId: row.document_id,
    actorId: row.actor_id, status: row.status, attemptCount: row.attempt_count,
  };
}
