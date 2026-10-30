import { describe, expect, it, jest } from '@jest/globals';
import type { TenantTransaction } from '../../../infrastructure/database/tenant-transaction.js';
import type { FactValueCipher } from '../application/extraction.types.js';
import { PostgresExtractionRepository } from './postgres-extraction.repository.js';

const tenantId = '00000000-0000-4000-8000-000000000001';
const actorId = '00000000-0000-4000-8000-000000000002';

describe('PostgresExtractionRepository fact update budget', () => {
  it('locks by tenant and counts actor, tenant, and lifetime fact audit events in the selected tenant', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ actor_count: '3', tenant_count: '12', lifetime_count: '940' }], rowCount: 1 });
    const repository = new PostgresExtractionRepository({} as FactValueCipher);
    const usage = await repository.lockAndGetFactUpdateUsage(tenantId, actorId, { query } as unknown as TenantTransaction);

    expect(query).toHaveBeenNthCalledWith(1,
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`fact-review:${tenantId}`]);
    expect(query.mock.calls[1]?.[0]).toContain("event_type IN ('fact.updated', 'fact.verified')");
    expect(query.mock.calls[1]?.[0]).toContain('WHERE tenant_id = $1');
    expect(query.mock.calls[1]?.[1]).toEqual([tenantId, actorId]);
    expect(usage).toEqual({ actorHourlyUpdates: 3, tenantHourlyUpdates: 12, tenantLifetimeUpdates: 940 });
  });
});
