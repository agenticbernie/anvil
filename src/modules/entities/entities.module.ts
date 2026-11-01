import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UNIT_OF_WORK } from '../../infrastructure/database/postgres.tokens.js';
import type { UnitOfWork } from '../../infrastructure/database/tenant-transaction.js';
import { AUDIT_EVENT_REPOSITORY } from '../audit/audit.tokens.js';
import type { AuditEventRepository } from '../audit/audit.types.js';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { EntityService } from './application/entity.service.js';
import { EntitiesController } from './api/entities.controller.js';
import { ENTITY_REPOSITORY } from './entities.tokens.js';
import { EntityNameCipherService } from './infrastructure/entity-name-cipher.service.js';
import { PostgresEntityRepository } from './infrastructure/postgres-entity.repository.js';

@Module({
  imports: [AuthModule, AuditModule],
  controllers: [EntitiesController],
  providers: [
    EntityNameCipherService,
    { provide: ENTITY_REPOSITORY, useClass: PostgresEntityRepository },
    {
      provide: EntityService,
      inject: [ENTITY_REPOSITORY, EntityNameCipherService, AUDIT_EVENT_REPOSITORY, UNIT_OF_WORK],
      useFactory: (entities: PostgresEntityRepository, cipher: EntityNameCipherService, audit: AuditEventRepository, unitOfWork: UnitOfWork) =>
        new EntityService(entities, cipher, audit, unitOfWork),
    },
  ],
})
export class EntitiesModule {}
