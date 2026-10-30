import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TenantJsonEncryptionService } from '../../common/security/tenant-json-encryption.service.js';
import { UNIT_OF_WORK } from '../../infrastructure/database/postgres.tokens.js';
import type { UnitOfWork } from '../../infrastructure/database/tenant-transaction.js';
import { IdempotencyService } from './application/idempotency.service.js';
import { IdempotencyInterceptor } from './idempotency.interceptor.js';
import { IDEMPOTENCY_REPOSITORY, IDEMPOTENCY_RESPONSE_CIPHER } from './idempotency.tokens.js';
import { HmacIdempotencyRequestHasher } from './infrastructure/hmac-idempotency-request-hasher.js';
import { TenantJsonIdempotencyResponseCipher } from './infrastructure/idempotency-response-cipher.js';
import { PostgresIdempotencyRepository } from './infrastructure/postgres-idempotency.repository.js';

@Global()
@Module({
  providers: [
    {
      provide: TenantJsonEncryptionService,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => new TenantJsonEncryptionService(config),
    },
    {
      provide: IDEMPOTENCY_RESPONSE_CIPHER,
      inject: [TenantJsonEncryptionService],
      useFactory: (cipher: TenantJsonEncryptionService) => new TenantJsonIdempotencyResponseCipher(cipher),
    },
    {
      provide: IDEMPOTENCY_REPOSITORY,
      inject: [UNIT_OF_WORK, IDEMPOTENCY_RESPONSE_CIPHER],
      useFactory: (unitOfWork: UnitOfWork, cipher: TenantJsonIdempotencyResponseCipher) => new PostgresIdempotencyRepository(unitOfWork, cipher),
    },
    {
      provide: IdempotencyService,
      inject: [ConfigService, IDEMPOTENCY_REPOSITORY],
      useFactory: (config: ConfigService, repository: PostgresIdempotencyRepository) => new IdempotencyService(
        repository,
        new HmacIdempotencyRequestHasher(
          decodeKey(config.getOrThrow<string>('IDEMPOTENCY_HASH_KEY_BASE64')),
          decodePreviousKeys(config.get<string>('IDEMPOTENCY_HASH_KEY_PREVIOUS_BASE64') ?? ''),
        ),
      ),
    },
    {
      provide: IdempotencyInterceptor,
      inject: [IdempotencyService],
      useFactory: (service: IdempotencyService) => new IdempotencyInterceptor(service),
    },
  ],
  exports: [IdempotencyInterceptor],
})
export class IdempotencyModule {}

function decodeKey(value: string): Buffer {
  const key = Buffer.from(value, 'base64');
  if (key.byteLength !== 32 || key.toString('base64') !== value) {
    throw new Error('IDEMPOTENCY_HASH_KEY_BASE64 must be a canonical base64-encoded 32-byte key.');
  }
  return key;
}

function decodePreviousKeys(value: string): readonly Buffer[] {
  if (value.length === 0) return [];
  return value.split(',').map((encoded) => {
    const key = Buffer.from(encoded, 'base64');
    if (key.byteLength !== 32 || key.toString('base64') !== encoded) {
      throw new Error('IDEMPOTENCY_HASH_KEY_PREVIOUS_BASE64 must contain comma-separated canonical base64-encoded 32-byte keys.');
    }
    return key;
  });
}
