import { ForbiddenException } from '@nestjs/common';
import type { DocumentVersionRepository } from '../application/document.types.js';

export class PostgresDocumentVersionRepository implements DocumentVersionRepository {
  async create(tenantId: string, actorId: string, input: Parameters<DocumentVersionRepository['create']>[2], transaction: Parameters<DocumentVersionRepository['create']>[3]): Promise<void> {
    await transaction.withBackendRole(async (tx) => {
      const result = await tx.query(
        `INSERT INTO public.document_versions
           (id, tenant_id, case_id, document_id, version_number, source_text_ciphertext, source_text_nonce,
            source_text_key_version, source_text_hash, source_page_count, source_kind)
         SELECT $1, $2, $3, $4, COALESCE((SELECT max(version_number) + 1 FROM public.document_versions
           WHERE tenant_id = $2 AND document_id = $4), 1), $5, $6, $7, $8, $9, 'mock'
         WHERE $10::uuid = (SELECT auth.uid()) AND public.is_tenant_member($2)
           AND public.has_tenant_role($2, ARRAY['tenant_admin', 'originator', 'analyst'])`,
        [input.id, tenantId, input.caseId, input.documentId, Buffer.from(input.sourceTextCiphertext), Buffer.from(input.sourceTextNonce), input.sourceTextKeyVersion, input.sourceTextHash, input.sourcePageCount, actorId],
      );
      if (result.rowCount !== 1) throw new ForbiddenException('Actor cannot persist this document version.');
    });
  }
}
