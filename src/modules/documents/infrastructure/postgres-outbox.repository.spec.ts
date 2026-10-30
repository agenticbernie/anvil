import { describe, expect, it, jest } from '@jest/globals';
import type { Pool } from 'pg';
import type { TenantTransaction } from '../../../infrastructure/database/tenant-transaction.js';
import { PostgresOutboxRepository } from './postgres-outbox.repository.js';

describe('PostgresOutboxRepository memo request budget', () => {
  it('rejects memo request growth at the tenant lifetime cap before inserting an outbox event', async () => {
    const query = jest.fn(async (sql: string) => {
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 0 };
      if (sql.includes('SELECT count(*)')) {
        return { rows: [{ actor_count: 0, tenant_count: 0, lifetime_count: 100_000 }], rowCount: 1 };
      }
      throw new Error('Unexpected SQL query.');
    });
    const scopedTransaction = { query } as unknown as TenantTransaction;
    const transaction = {
      withBackendRole: async (work: (tx: TenantTransaction) => Promise<void>) => work(scopedTransaction),
    } as unknown as TenantTransaction;
    const repository = new PostgresOutboxRepository({} as Pool);

    await expect(repository.create(
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000011',
      'memo.generate.requested',
      { caseId: '00000000-0000-4000-8000-000000000021', generationKey: '00000000-0000-4000-8000-000000000061' },
      transaction,
    )).rejects.toMatchObject({ status: 409 });

    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1]?.[0]).toContain('tenant_id = $1');
  });
});
