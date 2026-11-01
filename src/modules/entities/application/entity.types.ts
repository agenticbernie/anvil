import type { TenantTransaction } from '../../../infrastructure/database/tenant-transaction.js';

export type EntityType = 'individual' | 'business';

export interface EntityRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly entityType: EntityType;
  readonly createdAt: string;
}

export interface EncryptedEntityName {
  readonly ciphertext: Buffer;
  readonly nonce: Buffer;
  readonly keyVersion: string;
  readonly blindIndex: string;
}

export interface EntityRepository {
  create(
    tenantId: string,
    actorId: string,
    input: EntityRecord & EncryptedEntityName,
    transaction: TenantTransaction,
  ): Promise<EntityRecord>;
}

export interface EntityNameCipher {
  encrypt(tenantId: string, entityId: string, name: string): Omit<EncryptedEntityName, 'blindIndex'>;
  blindIndex(tenantId: string, name: string): string;
}
