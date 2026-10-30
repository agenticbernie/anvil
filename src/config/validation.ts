import Joi from 'joi';

const optionalHttpUrl = Joi.string()
  .uri({ scheme: ['http', 'https'] })
  .allow('')
  .optional();
const externalUrl = Joi.when('NODE_ENV', {
  is: 'production',
  then: Joi.string().uri({ scheme: ['https'] }).allow('').optional(),
  otherwise: optionalHttpUrl,
});
const redisUrl = Joi.when('NODE_ENV', {
  is: 'production',
  then: Joi.string().pattern(/^rediss:\/\//).allow('').optional(),
  otherwise: Joi.string().pattern(/^rediss?:\/\//).allow('').optional(),
});

const optionalSecret = Joi.string().allow('').optional();
const validatePiiEncryptionKey = (value: string, helpers: Joi.CustomHelpers) => {
  const decodedKey = Buffer.from(value, 'base64');
  if (decodedKey.length !== 32 || decodedKey.toString('base64') !== value) {
    return helpers.error('any.invalid');
  }
  return value;
};

const piiEncryptionKey = Joi.string()
  .base64()
  .length(44)
  .allow('')
  .optional()
  .custom((value: string, helpers) => value.length === 0 ? value : validatePiiEncryptionKey(value, helpers), 'base64-encoded 32-byte PII key');
const requiredPiiEncryptionKey = Joi.string()
  .base64()
  .length(44)
  .required()
  .custom(validatePiiEncryptionKey, 'base64-encoded 32-byte PII key');
const idempotencyHashKey = Joi.string()
  .base64()
  .length(44)
  .allow('')
  .optional()
  .custom((value: string, helpers) => value.length === 0 ? value : validatePiiEncryptionKey(value, helpers), 'base64-encoded 32-byte idempotency HMAC key');
const previousIdempotencyHashKeys = Joi.string()
  .allow('')
  .optional()
  .custom((value: string, helpers) => {
    if (value.length === 0) return value;
    const keys = value.split(',');
    if (keys.some((key) => key.length !== 44 || validateKeyEncoding(key) !== true)) return helpers.error('any.invalid');
    return value;
  }, 'comma-separated base64-encoded 32-byte previous idempotency HMAC keys');

function validateKeyEncoding(value: string): boolean {
  const decodedKey = Buffer.from(value, 'base64');
  return decodedKey.length === 32 && decodedKey.toString('base64') === value;
}

export const environmentValidationSchema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'test', 'production').default('development'),
  PORT: Joi.number().port().default(3000),
  LOG_LEVEL: Joi.string().valid('fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent').default('info'),
  API_PREFIX: Joi.string().pattern(/^[a-zA-Z0-9][a-zA-Z0-9/_-]*$/).default('v1'),
  SWAGGER_ENABLED: Joi.boolean().truthy('true').falsy('false').default(true),
  CORS_ORIGINS: Joi.string().allow('').default(''),
  REQUEST_ID_HEADER: Joi.string().pattern(/^[a-zA-Z0-9-]{1,64}$/).default('x-request-id'),

  SUPABASE_URL: externalUrl,
  SUPABASE_ANON_KEY: optionalSecret,
  SUPABASE_SERVICE_ROLE_KEY: optionalSecret,
  SUPABASE_JWKS_URL: externalUrl,
  DATABASE_URL: Joi.string().pattern(/^postgres(?:ql)?:\/\//).allow('').optional(),
  DATABASE_SSL: Joi.when('NODE_ENV', {
    is: 'production',
    then: Joi.boolean().truthy('true').falsy('false').valid(true).default(true),
    otherwise: Joi.boolean().truthy('true').falsy('false').default(true),
  }),
  DATABASE_POOL_MAX: Joi.number().integer().min(1).max(100).default(5),

  UPSTASH_REDIS_URL: redisUrl,
  UPSTASH_REDIS_TOKEN: optionalSecret,
  WORKER_CONCURRENCY: Joi.number().integer().min(1).max(100).default(1),

  R2_ENDPOINT: externalUrl,
  R2_BUCKET_NAME: Joi.string().pattern(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/).allow('').optional(),
  R2_REGION: Joi.string().default('auto'),
  R2_ACCESS_KEY_ID: optionalSecret,
  R2_SECRET_ACCESS_KEY: optionalSecret,
  PII_ENCRYPTION_KEY_BASE64: Joi.when('NODE_ENV', {
    is: 'production',
    then: requiredPiiEncryptionKey,
    otherwise: piiEncryptionKey,
  }),
  PII_ENCRYPTION_KEY_VERSION: Joi.string().pattern(/^v[1-9][0-9]*$/).default('v1'),
  IDEMPOTENCY_HASH_KEY_BASE64: idempotencyHashKey,
  IDEMPOTENCY_HASH_KEY_PREVIOUS_BASE64: previousIdempotencyHashKeys,

  LLM_PROVIDER: Joi.string().valid('openai').default('openai'),
  LLM_API_KEY: optionalSecret,
  LLM_MODEL: Joi.string().allow('').default(''),
  LLM_REQUEST_TIMEOUT_MS: Joi.number().integer().min(1_000).max(120_000).default(30_000),
  MAX_UPLOAD_BYTES: Joi.number().integer().min(1).max(1_073_741_824).default(52_428_800),
  BETTER_STACK_SOURCE_TOKEN: optionalSecret,
  BETTER_STACK_INGESTING_HOST: externalUrl,
}).unknown(true);
