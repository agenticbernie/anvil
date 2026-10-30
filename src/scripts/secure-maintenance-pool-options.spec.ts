import { secureMaintenancePoolOptions } from './secure-maintenance-pool-options.js';

describe('secureMaintenancePoolOptions', () => {
  it('forces certificate-verified TLS and removes an accepted sslmode hint', () => {
    const options = secureMaintenancePoolOptions('postgresql://operator:secret@db.example.test/anvil?sslmode=require&application_name=backfill');

    expect(options.ssl).toEqual({ rejectUnauthorized: true });
    expect(options.max).toBe(1);
    expect(new URL(options.connectionString).searchParams.has('sslmode')).toBe(false);
    expect(new URL(options.connectionString).searchParams.get('application_name')).toBe('backfill');
  });

  it.each(['disable', 'allow', 'prefer', 'no-verify', 'unknown'])('rejects insecure or ambiguous sslmode=%s', (sslmode) => {
    expect(() => secureMaintenancePoolOptions(`postgres://operator:secret@db.example.test/anvil?sslmode=${sslmode}`))
      .toThrow('insecure or ambiguous TLS mode');
  });

  it.each(['ssl', 'sslcert', 'sslkey', 'sslrootcert', 'sslcrl', 'uselibpqcompat', 'sslnegotiation'])('rejects URL TLS override %s', (parameter) => {
    expect(() => secureMaintenancePoolOptions(`postgres://operator:secret@db.example.test/anvil?${parameter}=value`))
      .toThrow('TLS override parameter');
  });

  it('rejects duplicate sslmode parameters', () => {
    expect(() => secureMaintenancePoolOptions('postgres://operator:secret@db.example.test/anvil?sslmode=require&sslmode=verify-full'))
      .toThrow('insecure or ambiguous TLS mode');
  });

  it.each(['https://db.example.test/anvil', 'postgres:///anvil', 'not-a-url'])('rejects invalid PostgreSQL URLs: %s', (url) => {
    expect(() => secureMaintenancePoolOptions(url)).toThrow();
  });
});
