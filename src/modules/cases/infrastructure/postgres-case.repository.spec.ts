import { describe, expect, it, jest } from '@jest/globals';
import type { TenantTransaction } from '../../../infrastructure/database/tenant-transaction.js';
import { PostgresCaseRepository } from './postgres-case.repository.js';

const tenantId = '00000000-0000-4000-8000-000000000001';
const actorId = '00000000-0000-4000-8000-000000000002';

describe('PostgresCaseRepository creation budget', () => {
  it('serializes tenant budget checks and counts hourly actor, tenant, and lifetime usage', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ actor_count: '4', tenant_count: '18' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ total_count: '240' }], rowCount: 1 });
    const transaction = { query } as unknown as TenantTransaction;

    const usage = await new PostgresCaseRepository().lockAndGetCreationUsage(tenantId, actorId, transaction);

    expect(query).toHaveBeenNthCalledWith(1,
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`case-creation:${tenantId}`]);
    expect(query.mock.calls[1]?.[0]).toContain('FROM public.audit_events');
    expect(query.mock.calls[1]?.[0]).toContain('WHERE tenant_id = $1');
    expect(query.mock.calls[1]?.[1]).toEqual([tenantId, actorId]);
    expect(query.mock.calls[2]?.[0]).toContain('FROM public.credit_cases WHERE tenant_id = $1');
    expect(query.mock.calls[2]?.[1]).toEqual([tenantId]);
    expect(usage).toEqual({ actorHourlyCreates: 4, tenantHourlyCreates: 18, tenantLifetimeCases: 240 });
  });
});
