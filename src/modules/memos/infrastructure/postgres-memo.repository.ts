import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { TenantTransaction } from '../../../infrastructure/database/tenant-transaction.js';
import type { CreditMemoContent } from '../application/memo.schema.js';
import type { MemoContentCipher, MemoRepository, MemoStatus, MemoVersion } from '../application/memo.types.js';

interface MemoRow extends Record<string, unknown> {
  id: string; tenant_id: string; case_id: string; version_number: number; input_hash: string;
  status: MemoStatus; content: unknown; approved_at: Date | string | null;
  rejected_at?: Date | string | null; rejection_reason_ciphertext?: unknown | null;
}

export class PostgresMemoRepository implements MemoRepository {
  constructor(private readonly contentCipher: MemoContentCipher) {}

  async claimGeneration(tenantId: string, actorId: string, caseId: string, inputHash: string, tx: TenantTransaction) {
    return tx.withBackendRole(async (backend) => {
      const caseLock = await backend.query(
        `SELECT id FROM public.credit_cases WHERE tenant_id = $1 AND id = $2 AND $3::uuid = (SELECT auth.uid()) FOR UPDATE`,
        [tenantId, caseId, actorId],
      );
      if (caseLock.rowCount !== 1) throw new NotFoundException('Credit case not found in this tenant.');
      const existing = await backend.query<MemoRow>(
        `SELECT * FROM public.memo_versions WHERE tenant_id = $1 AND case_id = $2 AND input_hash = $3 FOR UPDATE`,
        [tenantId, caseId, inputHash],
      );
      const old = existing.rows[0];
      if (old) {
        const attempts = Number((old as Record<string, unknown>).generation_attempts);
        const lockUntil = (old as Record<string, unknown>).generation_lock_expires_at;
        const activeLock = lockUntil !== null && lockUntil !== undefined && new Date(lockUntil as string).getTime() > Date.now();
        if (old.status === 'draft' || old.status === 'approved' || old.status === 'rejected' || (old.status === 'generating' && activeLock) || attempts >= 3) {
          return { memoId: old.id, versionNumber: Number(old.version_number), acquired: false };
        }
        const retried = await backend.query<MemoRow>(
          `UPDATE public.memo_versions SET status = 'generating', generation_attempts = generation_attempts + 1,
             generation_lock_expires_at = now() + interval '10 minutes'
           WHERE tenant_id = $1 AND id = $2 AND generation_attempts < 3 RETURNING *`, [tenantId, old.id],
        );
        const row = retried.rows[0];
        if (!row) return { memoId: old.id, versionNumber: Number(old.version_number), acquired: false };
        return { memoId: row.id, versionNumber: Number(row.version_number), acquired: true };
      }
      const version = await backend.query<{ next_version: number }>(
        `SELECT COALESCE(max(version_number), 0) + 1 AS next_version FROM public.memo_versions WHERE tenant_id = $1 AND case_id = $2`,
        [tenantId, caseId],
      );
      const inserted = await backend.query<MemoRow>(
        `INSERT INTO public.memo_versions (tenant_id, case_id, version_number, input_hash, status, generation_lock_expires_at)
         SELECT $1, $3, $4, $5, 'generating', now() + interval '10 minutes' WHERE $2::uuid = (SELECT auth.uid())
         RETURNING *`, [tenantId, actorId, caseId, Number(version.rows[0]?.next_version ?? 1), inputHash],
      );
      const row = inserted.rows[0];
      if (!row) throw new ForbiddenException('Actor cannot generate a memo for this tenant.');
      return { memoId: row.id, versionNumber: Number(row.version_number), acquired: true };
    });
  }

  async markDraft(tenantId: string, actorId: string, memoId: string, encryptedContent: unknown, tx: TenantTransaction): Promise<void> {
    await tx.withBackendRole(async (backend) => {
      const result = await backend.query(
        `UPDATE public.memo_versions SET status = 'draft', content = $4::jsonb, generation_lock_expires_at = NULL
         WHERE tenant_id = $1 AND id = $2 AND $3::uuid = (SELECT auth.uid()) AND status = 'generating'`,
        [tenantId, memoId, actorId, JSON.stringify(encryptedContent)],
      );
      if (result.rowCount !== 1) throw new ConflictException('Memo generation claim is no longer active.');
    });
  }

  async markFailed(tenantId: string, actorId: string, memoId: string, tx: TenantTransaction): Promise<void> {
    await tx.withBackendRole(async (backend) => {
      await backend.query(
        `UPDATE public.memo_versions SET status = 'failed', generation_lock_expires_at = NULL WHERE tenant_id = $1 AND id = $2
          AND $3::uuid = (SELECT auth.uid()) AND status = 'generating'`, [tenantId, memoId, actorId],
      );
    });
  }

  async getById(tenantId: string, actorId: string, memoId: string, tx: TenantTransaction): Promise<MemoVersion | null> {
    return tx.withBackendRole(async (backend) => {
      const result = await backend.query<MemoRow>(
        `SELECT * FROM public.memo_versions WHERE tenant_id = $1 AND id = $2 AND $3::uuid = (SELECT auth.uid())`,
        [tenantId, memoId, actorId],
      );
      return result.rows[0] ? this.map(tenantId, result.rows[0]) : null;
    });
  }

  async listByCase(tenantId: string, actorId: string, caseId: string, tx: TenantTransaction): Promise<readonly MemoVersion[]> {
    return tx.withBackendRole(async (backend) => {
      const result = await backend.query<MemoRow>(
        `SELECT * FROM public.memo_versions
         WHERE tenant_id = $1 AND case_id = $2 AND $3::uuid = (SELECT auth.uid())
         ORDER BY version_number DESC, id DESC`,
        [tenantId, caseId, actorId],
      );
      return result.rows.map((row) => this.map(tenantId, row));
    });
  }

  async approve(tenantId: string, actorId: string, memoId: string, encryptedReason: unknown | null, tx: TenantTransaction): Promise<MemoVersion> {
    return tx.withBackendRole(async (backend) => {
      const result = await backend.query<MemoRow>(
        `UPDATE public.memo_versions SET status = 'approved', approved_by = $3, approved_at = now(), approval_override_ciphertext = $4::jsonb
         WHERE tenant_id = $1 AND id = $2 AND status = 'draft' AND $3::uuid = (SELECT auth.uid()) RETURNING *`,
        [tenantId, memoId, actorId, encryptedReason === null ? null : JSON.stringify(encryptedReason)],
      );
      const row = result.rows[0];
      if (!row) throw new ConflictException('Memo is no longer a draft or actor does not match.');
      return this.map(tenantId, row);
    });
  }

  async reject(tenantId: string, actorId: string, memoId: string, encryptedReason: unknown, tx: TenantTransaction): Promise<MemoVersion> {
    return tx.withBackendRole(async (backend) => {
      const result = await backend.query<MemoRow>(
        `UPDATE public.memo_versions
         SET status = 'rejected', rejected_by = $3, rejected_at = now(), rejection_reason_ciphertext = $4::jsonb
         WHERE tenant_id = $1 AND id = $2 AND status = 'draft' AND $3::uuid = (SELECT auth.uid())
         RETURNING *`,
        [tenantId, memoId, actorId, JSON.stringify(encryptedReason)],
      );
      const row = result.rows[0];
      if (!row) throw new ConflictException('Memo is no longer a draft or actor does not match.');
      return this.map(tenantId, row);
    });
  }

  private map(tenantId: string, row: MemoRow): MemoVersion {
    return {
      id: row.id, tenantId, caseId: row.case_id, versionNumber: Number(row.version_number), inputHash: row.input_hash,
      status: row.status,
      content: row.content === null ? null : this.contentCipher.decrypt(tenantId, row.id, 'content', row.content) as CreditMemoContent,
      approvedAt: row.approved_at === null ? null : new Date(row.approved_at).toISOString(),
      rejectedAt: row.rejected_at === null || row.rejected_at === undefined ? null : new Date(row.rejected_at).toISOString(),
      rejectionReason: row.rejection_reason_ciphertext === null || row.rejection_reason_ciphertext === undefined
        ? null
        : this.contentCipher.decrypt(tenantId, row.id, 'rejection_reason', row.rejection_reason_ciphertext) as string,
    };
  }
}
