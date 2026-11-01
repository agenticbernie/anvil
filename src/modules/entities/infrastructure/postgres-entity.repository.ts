import { ForbiddenException } from '@nestjs/common';
import type { TenantTransaction } from '../../../infrastructure/database/tenant-transaction.js';
import type { EntityRecord, EntityRepository } from '../application/entity.types.js';

interface EntityRow extends Record<string, unknown> {
  id: string;
  tenant_id: string;
  entity_type: EntityRecord['entityType'];
  created_at: Date | string;
}

export class PostgresEntityRepository implements EntityRepository {
  async create(
    tenantId: string,
    actorId: string,
    input: EntityRecord & { ciphertext: Buffer; nonce: Buffer; keyVersion: string; blindIndex: string },
    transaction: TenantTransaction,
  ): Promise<EntityRecord> {
    return transaction.withBackendRole(async (backend) => {
      const result = await backend.query<EntityRow>(
        `INSERT INTO public.entities
           (id, tenant_id, legal_name_ciphertext, legal_name_nonce, legal_name_key_version, legal_name_blind_index, entity_type)
         SELECT $1, $2, $4, $5, $6, $7, $8
         WHERE $3::uuid = (SELECT auth.uid())
           AND public.is_tenant_member($2)
           AND public.has_tenant_role($2, ARRAY['tenant_admin', 'originator'])
         RETURNING id, tenant_id, entity_type, created_at`,
        [input.id, tenantId, actorId, input.ciphertext, input.nonce, input.keyVersion, input.blindIndex, input.entityType],
      );
      const row = result.rows[0];
      if (!row) throw new ForbiddenException('Actor cannot create entities for this tenant.');
      return {
        id: row.id,
        tenantId: row.tenant_id,
        entityType: row.entity_type,
        createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString(),
      };
    });
  }
}
