import { ConflictException, ForbiddenException, HttpException, HttpStatus } from '@nestjs/common';
import type { TenantTransaction } from '../../../infrastructure/database/tenant-transaction.js';
import type { CreateDocumentRecord, DocumentContentType, DocumentListItem, DocumentRecord, DocumentRepository } from '../application/document.types.js';

export const TENANT_DOCUMENT_UPLOAD_LIMITS = Object.freeze({
  lifetimeDocuments: 1_000,
  lifetimeCiphertextBytes: 10 * 1024 * 1024 * 1024,
});

interface DocumentRow extends Record<string, unknown> {
  id: string; tenant_id: string; case_id: string; uploaded_by: string; object_key: string;
  final_object_key: string | null;
  content_type: DocumentContentType; size_bytes: string | number; storage_size_bytes: string | number;
  sha256: string; wrapped_data_key: string | null; encryption_nonce: string | null;
  encryption_key_version: string | null; status: DocumentRecord['status'];
}

export class PostgresDocumentRepository implements DocumentRepository {
  async create(tenantId: string, actorId: string, input: CreateDocumentRecord, transaction: TenantTransaction): Promise<DocumentRecord> {
    return transaction.withBackendRole(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`document-upload:${tenantId}`]);
      const active = await tx.query<{ tenant_count: string | number; actor_count: string | number }>(
        `SELECT count(*) AS tenant_count,
                count(*) FILTER (WHERE uploaded_by = $2::uuid) AS actor_count
         FROM public.documents
         WHERE tenant_id = $1 AND status = 'pending_upload' AND reservation_expires_at > now()`,
        [tenantId, actorId],
      );
      if (Number(active.rows[0]?.tenant_count ?? 0) >= 100 || Number(active.rows[0]?.actor_count ?? 0) >= 10) {
        throw new HttpException('Too many active document upload reservations.', HttpStatus.TOO_MANY_REQUESTS);
      }
      const lifetime = await tx.query<{ document_count: string | number; ciphertext_bytes: string | number }>(
        `SELECT count(*) AS document_count, COALESCE(sum(storage_size_bytes), 0) AS ciphertext_bytes
         FROM public.documents
         WHERE tenant_id = $1`,
        [tenantId],
      );
      const documentCount = Number(lifetime.rows[0]?.document_count ?? 0);
      const ciphertextBytes = Number(lifetime.rows[0]?.ciphertext_bytes ?? 0);
      if (documentCount >= TENANT_DOCUMENT_UPLOAD_LIMITS.lifetimeDocuments
        || ciphertextBytes + input.storageSizeBytes > TENANT_DOCUMENT_UPLOAD_LIMITS.lifetimeCiphertextBytes) {
        throw new ConflictException('Tenant document lifetime storage limit has been reached.');
      }
      const actorWindow = await tx.query(
        `INSERT INTO public.document_upload_actor_limits (tenant_id, actor_id, window_start, request_count)
         VALUES ($1, $2, date_trunc('hour', now()), 1)
         ON CONFLICT (tenant_id, actor_id, window_start) DO UPDATE
           SET request_count = document_upload_actor_limits.request_count + 1
           WHERE document_upload_actor_limits.request_count < 50
         RETURNING request_count`,
        [tenantId, actorId],
      );
      const tenantWindow = await tx.query(
        `INSERT INTO public.document_upload_tenant_limits (tenant_id, window_start, request_count)
         VALUES ($1, date_trunc('hour', now()), 1)
         ON CONFLICT (tenant_id, window_start) DO UPDATE
           SET request_count = document_upload_tenant_limits.request_count + 1
           WHERE document_upload_tenant_limits.request_count < 500
         RETURNING request_count`,
        [tenantId],
      );
      if (actorWindow.rowCount !== 1 || tenantWindow.rowCount !== 1) {
        throw new HttpException('Document upload reservation rate limit exceeded.', HttpStatus.TOO_MANY_REQUESTS);
      }
      const result = await tx.query<DocumentRow>(
        `INSERT INTO public.documents (
           id, tenant_id, case_id, uploaded_by, object_key, content_type, size_bytes, storage_size_bytes,
           sha256, wrapped_data_key, encryption_nonce, encryption_key_version
         ) SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
           WHERE $4::uuid = (SELECT auth.uid())
         RETURNING id, tenant_id, case_id, uploaded_by, object_key, final_object_key, content_type, size_bytes, storage_size_bytes,
                   sha256, wrapped_data_key, encryption_nonce, encryption_key_version, status`,
        [input.id, tenantId, input.caseId, actorId, input.objectKey, input.contentType, input.sizeBytes,
          input.storageSizeBytes, input.sha256, input.wrappedDataKey, input.encryptionNonce, input.encryptionKeyVersion],
      );
      if (!result.rows[0]) throw new ForbiddenException('Actor does not match the authenticated database principal.');
      return toDocument(result.rows[0]);
    });
  }

  async findById(tenantId: string, actorId: string, documentId: string, transaction: TenantTransaction): Promise<DocumentRecord | null> {
    const result = await transaction.query<DocumentRow>(
      `SELECT id, tenant_id, case_id, uploaded_by, object_key, final_object_key, content_type, size_bytes, storage_size_bytes,
              sha256, wrapped_data_key, encryption_nonce, encryption_key_version, status
       FROM public.documents
       WHERE tenant_id = $1 AND $2::uuid = (SELECT auth.uid()) AND id = $3 AND deleted_at IS NULL
         AND (status <> 'pending_upload' OR reservation_expires_at > now())`,
      [tenantId, actorId, documentId],
    );
    return result.rows[0] ? toDocument(result.rows[0]) : null;
  }

  async listByCase(tenantId: string, actorId: string, caseId: string, transaction: TenantTransaction): Promise<readonly DocumentListItem[]> {
    const result = await transaction.query<{
      id: string; case_id: string; content_type: DocumentContentType; size_bytes: string | number;
      status: DocumentRecord['status']; created_at: Date | string; updated_at: Date | string;
    }>(
      `SELECT id, case_id, content_type, size_bytes, status, created_at, updated_at
       FROM public.documents
       WHERE tenant_id = $1 AND case_id = $3 AND $2::uuid = (SELECT auth.uid()) AND deleted_at IS NULL
         AND (status <> 'pending_upload' OR reservation_expires_at > now())
       ORDER BY created_at DESC, id DESC`,
      [tenantId, actorId, caseId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      caseId: row.case_id,
      contentType: row.content_type,
      sizeBytes: Number(row.size_bytes),
      status: row.status,
      createdAt: toIsoString(row.created_at),
      updatedAt: toIsoString(row.updated_at),
    }));
  }

  async reserveFinalObjectKey(
    tenantId: string, actorId: string, documentId: string, candidateKey: string, transaction: TenantTransaction,
  ): Promise<string> {
    return transaction.withBackendRole(async (tx) => {
      const claimed = await tx.query<{ final_object_key: string }>(
        `UPDATE public.documents SET final_object_key = $4
         WHERE tenant_id = $1 AND $2::uuid = (SELECT auth.uid()) AND id = $3
           AND status = 'pending_upload' AND reservation_expires_at > now() AND deleted_at IS NULL
           AND final_object_key IS NULL
         RETURNING final_object_key`,
        [tenantId, actorId, documentId, candidateKey],
      );
      if (claimed.rows[0]) return claimed.rows[0].final_object_key;

      const existing = await tx.query<{ final_object_key: string | null }>(
        `SELECT final_object_key FROM public.documents
         WHERE tenant_id = $1 AND $2::uuid = (SELECT auth.uid()) AND id = $3
           AND status = 'pending_upload' AND reservation_expires_at > now() AND deleted_at IS NULL
           AND final_object_key IS NOT NULL`,
        [tenantId, actorId, documentId],
      );
      if (existing.rows[0]?.final_object_key) return existing.rows[0].final_object_key;
      throw new ConflictException('Document reservation expired or is no longer awaiting upload confirmation.');
    });
  }

  async markUploaded(tenantId: string, actorId: string, documentId: string, finalObjectKey: string, transaction: TenantTransaction): Promise<boolean> {
    return transaction.withBackendRole(async (tx) => {
      const result = await tx.query(
        `UPDATE public.documents SET status = 'uploaded', final_object_key = $4, updated_at = now()
         WHERE tenant_id = $1 AND $2::uuid = (SELECT auth.uid()) AND id = $3
           AND status = 'pending_upload' AND reservation_expires_at > now() AND deleted_at IS NULL`,
        [tenantId, actorId, documentId, finalObjectKey],
      );
      return result.rowCount === 1;
    });
  }

  async markProcessing(tenantId: string, actorId: string, documentId: string, transaction: TenantTransaction): Promise<void> {
    await transaction.withBackendRole(async (tx) => {
      const result = await tx.query(
        `UPDATE public.documents SET status = 'processing', updated_at = now()
         WHERE tenant_id = $1 AND $2::uuid = (SELECT auth.uid()) AND id = $3 AND status IN ('uploaded', 'processing')`,
        [tenantId, actorId, documentId],
      );
      if (result.rowCount !== 1) throw new ConflictException('Document cannot enter processing from its current state.');
    });
  }

  async markProcessed(tenantId: string, actorId: string, documentId: string, transaction: TenantTransaction): Promise<void> {
    await transaction.withBackendRole(async (tx) => {
      const result = await tx.query(
        `UPDATE public.documents SET status = 'processed', updated_at = now()
         WHERE tenant_id = $1 AND $2::uuid = (SELECT auth.uid()) AND id = $3 AND status = 'processing'`,
        [tenantId, actorId, documentId],
      );
      if (result.rowCount !== 1) throw new ConflictException('Document is not in processing state.');
    });
  }

  async markFailed(tenantId: string, actorId: string, documentId: string, rejected: boolean, transaction: TenantTransaction): Promise<void> {
    await transaction.withBackendRole(async (tx) => {
      await tx.query(
        `UPDATE public.documents SET status = $4, updated_at = now()
         WHERE tenant_id = $1 AND $2::uuid = (SELECT auth.uid()) AND id = $3 AND status IN ('uploaded', 'processing')`,
        [tenantId, actorId, documentId, rejected ? 'rejected' : 'failed'],
      );
    });
  }
}

function toDocument(row: DocumentRow): DocumentRecord {
  return {
    id: row.id, tenantId: row.tenant_id, caseId: row.case_id, uploadedBy: row.uploaded_by,
    objectKey: row.object_key, finalObjectKey: row.final_object_key, contentType: row.content_type, sizeBytes: Number(row.size_bytes),
    storageSizeBytes: Number(row.storage_size_bytes), sha256: row.sha256.trim().toLowerCase(),
    wrappedDataKey: row.wrapped_data_key, encryptionNonce: row.encryption_nonce,
    encryptionKeyVersion: row.encryption_key_version, status: row.status,
  };
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
