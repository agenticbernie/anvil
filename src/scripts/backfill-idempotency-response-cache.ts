import 'dotenv/config';

import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { TenantJsonEncryptionService } from '../common/security/tenant-json-encryption.service.js';
import { TenantJsonIdempotencyResponseCipher } from '../modules/idempotency/infrastructure/idempotency-response-cipher.js';
import { backfillIdempotencyResponseCache } from '../modules/idempotency/infrastructure/idempotency-response-cache-backfill.js';
import { secureMaintenancePoolOptions } from './secure-maintenance-pool-options.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  if (args.some((argument) => argument !== '--apply' && argument !== '--dry-run') || (apply && args.includes('--dry-run'))) {
    throw new TypeError('Use either --dry-run or --apply.');
  }
  if (apply && process.env.IDEMPOTENCY_CACHE_BACKFILL_CONFIRM !== 'I_HAVE_STOPPED_ANVIL_WRITERS') {
    throw new Error('Apply mode requires the explicit maintenance confirmation environment variable.');
  }

  const connectionString = requiredEnvironment('IDEMPOTENCY_BACKFILL_DATABASE_URL');
  const config = new ConfigService({
    PII_ENCRYPTION_KEY_BASE64: requiredEnvironment('PII_ENCRYPTION_KEY_BASE64'),
    PII_ENCRYPTION_KEY_VERSION: process.env.PII_ENCRYPTION_KEY_VERSION || 'v1',
  });
  const pool = new Pool(secureMaintenancePoolOptions(connectionString));
  try {
    const cipher = new TenantJsonIdempotencyResponseCipher(new TenantJsonEncryptionService(config));
    const result = await backfillIdempotencyResponseCache(pool, cipher, apply);
    process.stdout.write(`${apply ? 'Applied' : 'Dry run'}: scanned=${result.scanned}, encrypted=${result.encrypted}, alreadyEncrypted=${result.alreadyEncrypted}.\n`);
  } finally {
    await pool.end();
  }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Required environment variable ${name} is missing.`);
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch((error: unknown) => {
    const errorType = error instanceof Error ? error.name : 'UnknownError';
    process.stderr.write(`Idempotency response cache backfill failed (${errorType}); cache contents and connection details were not logged.\n`);
    process.exitCode = 1;
  });
}
