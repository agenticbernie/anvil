import type { TenantJsonEncryptionService } from '../../../common/security/tenant-json-encryption.service.js';
import type { IdempotencyResponseCipher, IdempotencyScope } from '../idempotency.types.js';

const RESPONSE_FORMAT = 'anvil.idempotency-response';
const RESPONSE_FIELD = 'response_body';

interface EncryptedResponse {
  readonly format: typeof RESPONSE_FORMAT;
  readonly version: 1;
  readonly payload: Readonly<Record<string, unknown>>;
}

export class TenantJsonIdempotencyResponseCipher implements IdempotencyResponseCipher {
  constructor(private readonly jsonCipher: TenantJsonEncryptionService) {}

  encrypt(scope: IdempotencyScope, body: unknown): Readonly<Record<string, unknown>> {
    return {
      format: RESPONSE_FORMAT,
      version: 1,
      payload: this.jsonCipher.encrypt(scope.tenantId, resourceId(scope), RESPONSE_FIELD, body),
    };
  }

  decrypt(scope: IdempotencyScope, storedBody: unknown): unknown {
    const encrypted = parseEncryptedResponse(storedBody);
    return this.jsonCipher.decrypt(scope.tenantId, resourceId(scope), RESPONSE_FIELD, encrypted.payload);
  }

  isEncryptedResponse(storedBody: unknown): boolean {
    return Boolean(storedBody && typeof storedBody === 'object' && !Array.isArray(storedBody)
      && (storedBody as Record<string, unknown>).format === RESPONSE_FORMAT);
  }
}

function resourceId(scope: IdempotencyScope): string {
  return JSON.stringify([scope.actorId, scope.key, scope.requestHash]);
}

function parseEncryptedResponse(value: unknown): EncryptedResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || (value as Record<string, unknown>).format !== RESPONSE_FORMAT) {
    throw new TypeError('Idempotency response cache is not encrypted.');
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== 1 || !candidate.payload || typeof candidate.payload !== 'object' || Array.isArray(candidate.payload)) {
    throw new TypeError('Encrypted idempotency response envelope is invalid.');
  }
  return { format: RESPONSE_FORMAT, version: 1, payload: candidate.payload as Readonly<Record<string, unknown>> };
}
