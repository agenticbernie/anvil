import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AuditEventRepository } from '../../audit/audit.types.js';
import type { TenantDatabaseScope, UnitOfWork } from '../../../infrastructure/database/tenant-transaction.js';
import type { TenantRole } from '../../cases/application/case.types.js';
import type { EntityNameCipher, EntityRecord, EntityRepository, EntityType } from './entity.types.js';

export interface CreateEntityInput {
  readonly name: string;
  readonly type: EntityType;
}

@Injectable()
export class EntityService {
  constructor(
    private readonly entities: EntityRepository,
    private readonly nameCipher: EntityNameCipher,
    private readonly audit: AuditEventRepository,
    private readonly unitOfWork: UnitOfWork,
  ) {}

  async create(tenantId: string, actorId: string, role: TenantRole, input: CreateEntityInput): Promise<EntityRecord> {
    if (role !== 'tenant_admin' && role !== 'originator') {
      throw new ForbiddenException('Role is not allowed to create entities.');
    }
    const name = input.name.trim();
    if (name.length < 1 || name.length > 100) throw new BadRequestException('Entity name must contain 1 to 100 characters.');
    if (input.type !== 'individual' && input.type !== 'business') throw new BadRequestException('Entity type is invalid.');

    const scope = { tenantId, actorId } satisfies TenantDatabaseScope;
    return this.unitOfWork.run(scope, async (transaction) => {
      const id = randomUUID();
      const encryptedName = this.nameCipher.encrypt(tenantId, id, name);
      const entity = await this.entities.create(tenantId, actorId, {
        id,
        tenantId,
        entityType: input.type,
        createdAt: new Date().toISOString(),
        ...encryptedName,
        blindIndex: this.nameCipher.blindIndex(tenantId, name),
      }, transaction);
      // Keep PII out of audit metadata; the keyed digest supports exact lookup only.
      await this.audit.record(tenantId, actorId, {
        type: 'entity.created', resourceType: 'entity', resourceId: id,
        metadata: { entityType: entity.entityType, nameBlindIndex: this.nameCipher.blindIndex(tenantId, name) },
      }, transaction);
      return entity;
    });
  }
}
