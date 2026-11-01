import { randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { TenantTransaction } from '../../../infrastructure/database/tenant-transaction.js';
import type { ExtractedFact, ExtractionRepository, ExtractionRun } from '../application/extraction.types.js';
import type { FactValueCipher } from '../application/extraction.types.js';

interface RunRow extends Record<string, unknown> {
  id: string; tenant_id: string; case_id: string; document_version_id: string; model_name: string;
  prompt_hash: string; status: ExtractionRun['status']; attempt_count: number; lock_expires_at: string | null;
}
interface FactRow extends Record<string, unknown> {
  id: string; tenant_id: string; extraction_run_id: string; case_id: string; field_name: string;
  raw_value: unknown; normalized_value: unknown; source_page: number; confidence: number;
  review_status: ExtractedFact['reviewStatus']; is_critical: boolean;
}

const CRITICAL_FIELDS = new Set(['annual_revenue', 'ebitda', 'debt', 'cash_balance', 'requested_amount', 'loan_amount']);

export class PostgresExtractionRepository implements ExtractionRepository {
  constructor(private readonly valueCipher: FactValueCipher) {}

  async findDocumentVersion(tenantId: string, actorId: string, versionId: string, tx: TenantTransaction) {
    return tx.withBackendRole(async (backend) => {
      const result = await backend.query(
        `SELECT id, tenant_id, case_id, document_id, source_text_ciphertext, source_text_nonce,
                source_text_key_version, source_page_count
         FROM public.document_versions WHERE tenant_id = $1 AND id = $2 AND $3::uuid = NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid`,
        [tenantId, versionId, actorId],
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        id: String(row.id), tenantId: String(row.tenant_id), caseId: String(row.case_id), documentId: String(row.document_id),
        sourceTextCiphertext: Buffer.from(row.source_text_ciphertext as Uint8Array),
        sourceTextNonce: Buffer.from(row.source_text_nonce as Uint8Array), sourceTextKeyVersion: String(row.source_text_key_version),
        sourcePageCount: Number(row.source_page_count),
      };
    });
  }

  async beginRun(tenantId: string, actorId: string, input: { caseId: string; documentVersionId: string; modelName: string; promptHash: string }, tx: TenantTransaction) {
    return tx.withBackendRole(async (backend) => {
      const inserted = await backend.query<RunRow>(
        `INSERT INTO public.extraction_runs (tenant_id, case_id, document_version_id, model_name, prompt_hash, lock_expires_at)
         SELECT $1, $3, $4, $5, $6, now() + interval '10 minutes'
         WHERE $2::uuid = NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid AND public.is_tenant_member($1)
           AND public.has_tenant_role($1, ARRAY['tenant_admin', 'originator', 'analyst'])
         ON CONFLICT (tenant_id, document_version_id, model_name, prompt_hash) DO NOTHING
         RETURNING *`, [tenantId, actorId, input.caseId, input.documentVersionId, input.modelName, input.promptHash],
      );
      if (inserted.rows[0]) return { run: mapRun(inserted.rows[0]), acquired: true };
      const existing = await backend.query<RunRow>(
        `SELECT * FROM public.extraction_runs WHERE tenant_id = $1 AND document_version_id = $2
          AND model_name = $3 AND prompt_hash = $4 FOR UPDATE`,
        [tenantId, input.documentVersionId, input.modelName, input.promptHash],
      );
      const row = existing.rows[0];
      if (!row) throw new ForbiddenException('Actor cannot create extraction work for this tenant.');
      const terminal = row.status === 'succeeded' || row.status === 'failed_validation' || row.status === 'failed';
      const lockActive = row.lock_expires_at !== null && new Date(row.lock_expires_at).getTime() > Date.now();
      if (terminal || (row.status === 'processing' && lockActive) || Number(row.attempt_count) >= 3) {
        return { run: mapRun(row), acquired: false };
      }
      const resumed = await backend.query<RunRow>(
        `UPDATE public.extraction_runs SET status = 'processing', attempt_count = attempt_count + 1,
           lock_expires_at = now() + interval '10 minutes', started_at = now(), completed_at = NULL
         WHERE tenant_id = $1 AND id = $2 AND status IN ('retry_wait', 'processing') AND attempt_count < 3
         RETURNING *`, [tenantId, row.id],
      );
      const updated = resumed.rows[0];
      return updated ? { run: mapRun(updated), acquired: true } : { run: mapRun(row), acquired: false };
    });
  }

  async insertFacts(tenantId: string, actorId: string, runId: string, caseId: string,
    facts: readonly { fieldName: string; rawValue: unknown; normalizedValue: unknown; sourcePage: number; confidence: number }[], tx: TenantTransaction) {
    return tx.withBackendRole(async (backend) => {
      const output: ExtractedFact[] = [];
      for (const fact of facts) {
        const id = randomUUID();
        const rawValue = this.valueCipher.encrypt(tenantId, id, 'raw_value', fact.rawValue);
        const normalizedValue = this.valueCipher.encrypt(tenantId, id, 'normalized_value', fact.normalizedValue);
        const result = await backend.query<FactRow>(
          `INSERT INTO public.extracted_facts
             (id, tenant_id, extraction_run_id, case_id, field_name, raw_value, normalized_value, source_page, confidence, is_critical)
           SELECT $1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10
           WHERE $11::uuid = NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid AND public.is_tenant_member($2)
             AND public.has_tenant_role($2, ARRAY['tenant_admin', 'originator', 'analyst'])
           RETURNING *`,
          [id, tenantId, runId, caseId, fact.fieldName, JSON.stringify(rawValue), JSON.stringify(normalizedValue), fact.sourcePage, fact.confidence, CRITICAL_FIELDS.has(fact.fieldName), actorId],
        );
        if (!result.rows[0]) throw new ForbiddenException('Actor cannot persist extracted facts for this tenant.');
        const insertedRow = result.rows[0];
        output.push({
          id: insertedRow.id, tenantId, extractionRunId: runId, caseId, fieldName: fact.fieldName,
          rawValue: fact.rawValue, normalizedValue: fact.normalizedValue, sourcePage: fact.sourcePage,
          confidence: fact.confidence, reviewStatus: 'unverified', isCritical: CRITICAL_FIELDS.has(fact.fieldName),
        });
      }
      return output;
    });
  }

  async markRunSucceeded(tenantId: string, actorId: string, runId: string, cost: number | null, tx: TenantTransaction): Promise<void> {
    await this.updateRun(tenantId, actorId, runId, `status = 'succeeded', cost_estimate = $4, completed_at = now(), lock_expires_at = NULL, validation_error_code = NULL`, [cost], tx);
  }
  async markRunFailedValidation(tenantId: string, actorId: string, runId: string, validationCode: string, tx: TenantTransaction): Promise<void> {
    const safeCode = validationCode.slice(0, 500);
    await this.updateRun(tenantId, actorId, runId, `status = 'failed_validation', validation_error_code = $4, completed_at = now(), lock_expires_at = NULL`, [safeCode], tx);
  }
  async markRunRetryWait(tenantId: string, actorId: string, runId: string, tx: TenantTransaction): Promise<void> {
    await this.updateRun(tenantId, actorId, runId, `status = CASE WHEN attempt_count >= 3 THEN 'failed' ELSE 'retry_wait' END,
      completed_at = CASE WHEN attempt_count >= 3 THEN now() ELSE NULL END, lock_expires_at = NULL`, [], tx);
  }

  async lockAndGetFactUpdateUsage(tenantId: string, actorId: string, tx: TenantTransaction) {
    // Serialize quota checks with the fact and audit writes across API instances.
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`fact-review:${tenantId}`]);
    const result = await tx.query<{ actor_count: number | string; tenant_count: number | string; lifetime_count: number | string }>(
      `SELECT count(*) FILTER (WHERE actor_id = $2::uuid AND created_at >= now() - interval '1 hour') AS actor_count,
              count(*) FILTER (WHERE created_at >= now() - interval '1 hour') AS tenant_count,
              count(*) AS lifetime_count
       FROM public.audit_events
       WHERE tenant_id = $1 AND event_type IN ('fact.updated', 'fact.verified')`,
      [tenantId, actorId],
    );
    return {
      actorHourlyUpdates: Number(result.rows[0]?.actor_count ?? 0),
      tenantHourlyUpdates: Number(result.rows[0]?.tenant_count ?? 0),
      tenantLifetimeUpdates: Number(result.rows[0]?.lifetime_count ?? 0),
    };
  }

  async getFact(tenantId: string, actorId: string, factId: string, tx: TenantTransaction): Promise<ExtractedFact | null> {
    return tx.withBackendRole(async (backend) => {
      const result = await backend.query<FactRow>(
        `SELECT * FROM public.extracted_facts WHERE tenant_id = $1 AND id = $2 AND $3::uuid = NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid`,
        [tenantId, factId, actorId],
      );
      return result.rows[0] ? this.mapFact(result.rows[0]) : null;
    });
  }

  async updateFact(tenantId: string, actorId: string, factId: string,
    input: { normalizedValue?: unknown; reviewStatus?: ExtractedFact['reviewStatus']; isCritical?: boolean }, tx: TenantTransaction): Promise<ExtractedFact> {
    return tx.withBackendRole(async (backend) => {
      const result = await backend.query<FactRow>(
        `UPDATE public.extracted_facts SET
           normalized_value = CASE WHEN $4::boolean THEN $5::jsonb ELSE normalized_value END,
           review_status = COALESCE($6, review_status),
           is_critical = COALESCE($7::boolean, is_critical), updated_at = now()
         WHERE tenant_id = $1 AND id = $2 AND $3::uuid = NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
         RETURNING *`,
        [tenantId, factId, actorId, input.normalizedValue !== undefined,
          input.normalizedValue === undefined ? null : JSON.stringify(this.valueCipher.encrypt(tenantId, factId, 'normalized_value', input.normalizedValue)),
          input.reviewStatus ?? null, input.isCritical ?? null],
      );
      if (!result.rows[0]) throw new NotFoundException('Fact not found in this tenant.');
      return this.mapFact(result.rows[0]);
    });
  }

  async listFactsForCase(tenantId: string, actorId: string, caseId: string, tx: TenantTransaction, reviewStatus?: ExtractedFact['reviewStatus']): Promise<readonly ExtractedFact[]> {
    return tx.withBackendRole(async (backend) => {
      const result = await backend.query<FactRow>(
        `SELECT * FROM public.extracted_facts
         WHERE tenant_id = $1 AND case_id = $2 AND $3::uuid = NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
           AND ($4::text IS NULL OR review_status = $4)
         ORDER BY created_at, id`,
        [tenantId, caseId, actorId, reviewStatus ?? null],
      );
      return result.rows.map((row) => this.mapFact(row));
    });
  }

  async lockCriticalFactsForCase(tenantId: string, actorId: string, caseId: string, tx: TenantTransaction): Promise<void> {
    await tx.withBackendRole(async (backend) => {
      await backend.query(
        `SELECT id FROM public.extracted_facts
         WHERE tenant_id = $1 AND case_id = $2 AND $3::uuid = NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid AND is_critical
         ORDER BY id FOR UPDATE`,
        [tenantId, caseId, actorId],
      );
    });
  }

  async countUnresolvedCriticalConflicts(tenantId: string, actorId: string, caseId: string, tx: TenantTransaction): Promise<number> {
    return tx.withBackendRole(async (backend) => {
      const result = await backend.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM public.extracted_facts
         WHERE tenant_id = $1 AND case_id = $2 AND $3::uuid = NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid AND is_critical AND review_status = 'conflict'`,
        [tenantId, caseId, actorId],
      );
      return Number(result.rows[0]?.count ?? 0);
    });
  }

  private async updateRun(tenantId: string, actorId: string, runId: string, setClause: string, extra: readonly unknown[], tx: TenantTransaction): Promise<void> {
    await tx.withBackendRole(async (backend) => {
      const result = await backend.query(
        `UPDATE public.extraction_runs SET ${setClause} WHERE tenant_id = $1 AND id = $2
           AND $3::uuid = NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid AND status IN ('processing', 'retry_wait')`,
        [tenantId, runId, actorId, ...extra],
      );
      if (result.rowCount !== 1) throw new ConflictException('Extraction run is no longer active.');
    });
  }

  private mapFact(row: FactRow): ExtractedFact {
    return {
      id: row.id, tenantId: row.tenant_id, extractionRunId: row.extraction_run_id, caseId: row.case_id,
      fieldName: row.field_name,
      rawValue: this.valueCipher.decrypt(row.tenant_id, row.id, 'raw_value', row.raw_value),
      normalizedValue: this.valueCipher.decrypt(row.tenant_id, row.id, 'normalized_value', row.normalized_value),
      sourcePage: Number(row.source_page), confidence: Number(row.confidence), reviewStatus: row.review_status, isCritical: row.is_critical,
    };
  }
}

function mapRun(row: RunRow): ExtractionRun {
  return {
    id: row.id, tenantId: row.tenant_id, caseId: row.case_id, documentVersionId: row.document_version_id,
    modelName: row.model_name, promptHash: row.prompt_hash, status: row.status,
    attemptCount: Number(row.attempt_count), lockExpiresAt: row.lock_expires_at,
  };
}
