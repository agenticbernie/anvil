import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SUPABASE_CA_PATH = resolve(process.cwd(), 'certs/supabase-prod-ca-2021.crt');

export type DatabaseSslOptions = false | {
  rejectUnauthorized: true;
  ca?: string;
};

export function createDatabaseSslOptions(enabled: boolean, databaseUrl?: string): DatabaseSslOptions {
  if (!enabled) return false;

  if (!databaseUrl) return { rejectUnauthorized: true };

  const hostname = new URL(databaseUrl).hostname.toLowerCase();
  const usesSupabaseDatabase = hostname.endsWith('.pooler.supabase.com')
    || hostname.endsWith('.supabase.co');

  if (!usesSupabaseDatabase) return { rejectUnauthorized: true };

  // Supabase publishes this public trust anchor; the fingerprint is pinned in the deployment artifact.
  const ca = readFileSync(SUPABASE_CA_PATH, 'utf8');
  return { ca, rejectUnauthorized: true };
}
