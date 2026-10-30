import { X509Certificate } from 'node:crypto';
import { describe, expect, it } from '@jest/globals';
import { createDatabaseSslOptions } from './database-ssl-options.js';

describe('createDatabaseSslOptions', () => {
  it('trusts the Supabase root CA while keeping certificate verification enabled', () => {
    const options = createDatabaseSslOptions(true, 'postgresql://user:password@aws-1-eu-central-1.pooler.supabase.com:5432/postgres');

    expect(options).not.toBe(false);
    if (options === false) throw new Error('TLS must be enabled for this case.');
    expect(options.rejectUnauthorized).toBe(true);
    expect(new X509Certificate(options.ca ?? '').fingerprint256).toBe(
      '80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA',
    );
  });

  it('retains default CA verification for non-Supabase databases', () => {
    expect(createDatabaseSslOptions(true, 'postgresql://user:password@db.example.test:5432/anvil'))
      .toEqual({ rejectUnauthorized: true });
  });

  it('keeps TLS disabled only when explicitly configured off', () => {
    expect(createDatabaseSslOptions(false, 'postgresql://user:password@aws-1-eu-central-1.pooler.supabase.com:5432/postgres'))
      .toBe(false);
  });

  it('surfaces malformed database URLs instead of silently weakening TLS', () => {
    expect(() => createDatabaseSslOptions(true, 'not-a-database-url')).toThrow();
  });
});
