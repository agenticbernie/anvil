const permittedSslModes = new Set(['require', 'verify-ca', 'verify-full']);
const forbiddenSslParameters = ['ssl', 'sslcert', 'sslkey', 'sslrootcert', 'sslcrl', 'uselibpqcompat', 'sslnegotiation'];

export interface SecureMaintenancePoolOptions {
  readonly connectionString: string;
  readonly ssl: { readonly rejectUnauthorized: true };
  readonly max: 1;
}

export function secureMaintenancePoolOptions(connectionString: string): SecureMaintenancePoolOptions {
  let databaseUrl: URL;
  try {
    databaseUrl = new URL(connectionString);
  } catch {
    throw new TypeError('Backfill database URL must be a valid PostgreSQL URL.');
  }

  if (!['postgres:', 'postgresql:'].includes(databaseUrl.protocol) || !databaseUrl.hostname) {
    throw new TypeError('Backfill database URL must include a PostgreSQL host.');
  }

  const sslModes = databaseUrl.searchParams.getAll('sslmode');
  if (sslModes.length > 1 || (sslModes.length === 1 && !permittedSslModes.has(sslModes[0] ?? ''))) {
    throw new TypeError('Backfill database URL contains an insecure or ambiguous TLS mode.');
  }
  if (forbiddenSslParameters.some((parameter) => databaseUrl.searchParams.has(parameter))) {
    throw new TypeError('Backfill database URL contains a TLS override parameter.');
  }

  // Remove pg's URL-level SSL parsing so the explicit verified-TLS option below is authoritative.
  databaseUrl.searchParams.delete('sslmode');
  return {
    connectionString: databaseUrl.toString(),
    ssl: { rejectUnauthorized: true },
    max: 1,
  };
}
