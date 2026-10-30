import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import test from 'node:test';
import pino from 'pino';
import { environmentValidationSchema } from '../src/config/validation.ts';
import { assertSupportedLlmProvider } from '../src/config/llm-provider.guard.ts';
import {
  REDACTED_VALUE,
  SENSITIVE_LOG_FIELDS,
} from '../src/common/logging/redact-fields.ts';

test('accepts a base64-encoded 32-byte PII encryption key', () => {
  const encryptionKey = Buffer.alloc(32).toString('base64');
  const { error } = environmentValidationSchema.validate({
    PII_ENCRYPTION_KEY_BASE64: encryptionKey,
    IDEMPOTENCY_HASH_KEY_BASE64: Buffer.alloc(32, 1).toString('base64'),
  });

  assert.equal(error, undefined);
});

test('rejects a malformed PII encryption key', () => {
  const { error } = environmentValidationSchema.validate({
    PII_ENCRYPTION_KEY_BASE64: 'not-a-valid-key',
    IDEMPOTENCY_HASH_KEY_BASE64: Buffer.alloc(32, 1).toString('base64'),
  });

  assert.ok(error);
});

test('rejects a base64 key that decodes to more than 32 bytes', () => {
  const { error } = environmentValidationSchema.validate({
    PII_ENCRYPTION_KEY_BASE64: Buffer.alloc(33).toString('base64'),
    IDEMPOTENCY_HASH_KEY_BASE64: Buffer.alloc(32, 1).toString('base64'),
  });

  assert.ok(error);
});

test('requires an application encryption key in production', () => {
  const { error } = environmentValidationSchema.validate({
    NODE_ENV: 'production',
    IDEMPOTENCY_HASH_KEY_BASE64: Buffer.alloc(32, 1).toString('base64'),
  });
  assert.ok(error);
});

test('allows worker production config to omit the web-only idempotency HMAC key', () => {
  const piiKey = Buffer.alloc(32, 4).toString('base64');
  const { error } = environmentValidationSchema.validate({
    NODE_ENV: 'production',
    PII_ENCRYPTION_KEY_BASE64: piiKey,
  });

  assert.equal(error, undefined);
});

test('accepts the wired OpenAI provider and rejects an unsupported provider before startup', () => {
  assert.equal(environmentValidationSchema.validate({ LLM_PROVIDER: 'openai' }).error, undefined);
  assert.ok(environmentValidationSchema.validate({ LLM_PROVIDER: 'anthropic' }).error);
  assert.doesNotThrow(() => assertSupportedLlmProvider('openai'));
  assert.doesNotThrow(() => assertSupportedLlmProvider(undefined));
  assert.throws(() => assertSupportedLlmProvider('anthropic'), /Only the configured OpenAI LLM provider is supported/);
});

test('rejects malformed active and previous idempotency HMAC keys', () => {
  const validKey = Buffer.alloc(32, 4).toString('base64');
  assert.ok(environmentValidationSchema.validate({ IDEMPOTENCY_HASH_KEY_BASE64: 'not-a-key' }).error);
  assert.ok(environmentValidationSchema.validate({
    IDEMPOTENCY_HASH_KEY_BASE64: validKey,
    IDEMPOTENCY_HASH_KEY_PREVIOUS_BASE64: `${validKey},not-a-key`,
  }).error);
});

test('requires TLS URLs and database SSL in production', () => {
  const encryptionKey = Buffer.alloc(32, 3).toString('base64');
  const base = {
    NODE_ENV: 'production',
    DATABASE_SSL: 'true',
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_JWKS_URL: 'https://example.supabase.co/auth/v1/.well-known/jwks.json',
    R2_ENDPOINT: 'https://account.r2.cloudflarestorage.com',
    UPSTASH_REDIS_URL: 'rediss://default:token@example.upstash.io:6379',
    PII_ENCRYPTION_KEY_BASE64: encryptionKey,
    IDEMPOTENCY_HASH_KEY_BASE64: Buffer.alloc(32, 7).toString('base64'),
  };
  assert.equal(environmentValidationSchema.validate(base).error, undefined);
  assert.ok(environmentValidationSchema.validate({ ...base, DATABASE_SSL: 'false' }).error);
  assert.ok(environmentValidationSchema.validate({ ...base, UPSTASH_REDIS_URL: 'redis://default:token@example.upstash.io:6379' }).error);
  assert.ok(environmentValidationSchema.validate({ ...base, R2_ENDPOINT: 'http://account.r2.cloudflarestorage.com' }).error);
});

test('redaction paths cover request URLs and common secret fields', () => {
  assert.ok(SENSITIVE_LOG_FIELDS.includes('req.url'));
  assert.ok(SENSITIVE_LOG_FIELDS.includes('req.query'));
  assert.ok(SENSITIVE_LOG_FIELDS.includes('req.headers.authorization'));
  assert.ok(SENSITIVE_LOG_FIELDS.includes('req.body.access_token'));
  assert.ok(SENSITIVE_LOG_FIELDS.includes('*.keyBase64'));
  assert.ok(SENSITIVE_LOG_FIELDS.includes('*.wrappedDataKey'));
  assert.ok(SENSITIVE_LOG_FIELDS.includes('*.idempotency_hash_key_base64'));
  assert.ok(SENSITIVE_LOG_FIELDS.includes('*.IDEMPOTENCY_HASH_KEY_BASE64'));
});

test('Pino redacts query strings from structured request logs', () => {
  let output = '';
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    },
  });
  const logger = pino(
    {
      redact: { paths: SENSITIVE_LOG_FIELDS, censor: REDACTED_VALUE },
      serializers: { req: pino.stdSerializers.req },
    },
    destination,
  );

  const queryValue = 'sample-sensitive-value';
  logger.info({
    IDEMPOTENCY_HASH_KEY_BASE64: queryValue,
    req: {
      method: 'GET',
      url: `/health/live?access_token=${queryValue}`,
      query: { access_token: queryValue },
      headers: { authorization: `Bearer ${queryValue}` },
      socket: { remoteAddress: '127.0.0.1', remotePort: 3000 },
    },
  });

  const record = JSON.parse(output);
  assert.equal(record.req.url, REDACTED_VALUE);
  assert.equal(record.req.query, REDACTED_VALUE);
  assert.equal(record.req.headers.authorization, REDACTED_VALUE);
  assert.equal(record.IDEMPOTENCY_HASH_KEY_BASE64, REDACTED_VALUE);
  assert.equal(output.includes(queryValue), false);
});

