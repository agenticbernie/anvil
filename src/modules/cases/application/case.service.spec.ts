import { BadRequestException, ForbiddenException, ConflictException } from '@nestjs/common';
import { describe, expect, it, jest } from '@jest/globals';
import { CaseService } from './case.service.js';
import type { CaseRepository, CreditCase, TenantTransaction } from './case.types.js';
import type { UnitOfWork } from '../../../infrastructure/database/tenant-transaction.js';
import type { AuditEventRepository } from '../../audit/audit.types.js';

const tenantId = '00000000-0000-4000-8000-000000000001';
const actorId = '00000000-0000-4000-8000-000000000002';
const entityId = '00000000-0000-4000-8000-000000000003';
const tx = {} as TenantTransaction;

function sampleCase(overrides: Partial<CreditCase> = {}): CreditCase {
  return {
    id: '00000000-0000-4000-8000-000000000004', tenantId, entityId,
    caseNumber: 'CS-20261029-A1B2C3D4', status: 'draft', currency: 'USD', version: 1,
    createdAt: '2026-10-29T00:00:00.000Z', updatedAt: '2026-10-29T00:00:00.000Z', deletedAt: null,
    ...overrides,
  };
}

function harness(
  current: CreditCase = sampleCase(),
  usage = { actorHourlyCreates: 0, tenantHourlyCreates: 0, tenantLifetimeCases: 0 },
) {
  const cases: CaseRepository = {
    create: jest.fn(async (scope, _actor, input) => sampleCase({ tenantId: scope, ...input })),
    findById: jest.fn(async () => current),
    findByTenant: jest.fn(async () => ({ records: [current], hasMore: false })),
    lockAndGetCreationUsage: jest.fn(async () => usage),
    updateStatus: jest.fn(async (_scope, _actor, _id, _version, status) => sampleCase({ status, version: current.version + 1 })),
    softDelete: jest.fn(async () => sampleCase({ status: 'archived', deletedAt: '2026-10-29T01:00:00.000Z' })),
  };
  const recorded: string[] = [];
  const audit: AuditEventRepository = { record: jest.fn(async (_tenant, _actor, event, _tx) => { recorded.push(event.type); }) };
  const uow: UnitOfWork = { run: jest.fn(async (_scope, work) => work(tx)) };
  const service = new CaseService(cases, audit, uow, () => 'CS-20261029-A1B2C3D4');
  return { service, cases, audit, uow, recorded };
}

describe('CaseService', () => {
  it('creates in the authenticated tenant as draft and records audit in the same unit of work', async () => {
    const h = harness();
    const result = await h.service.create(tenantId, actorId, 'originator', { entityId, currency: 'USD' });
    expect(result.status).toBe('draft');
    expect(h.cases.create).toHaveBeenCalledWith(tenantId, actorId, expect.objectContaining({ entityId, status: 'draft' }), tx);
    expect(h.audit.record).toHaveBeenCalledWith(tenantId, actorId, expect.objectContaining({ type: 'case.created' }), tx);
  });

  it('rejects create roles outside tenant_admin and originator', async () => {
    const h = harness();
    await expect(h.service.create(tenantId, actorId, 'viewer', { entityId, currency: 'USD' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(h.cases.create).not.toHaveBeenCalled();
  });

  it('rejects malformed currency before writing', async () => {
    const h = harness();
    await expect(h.service.create(tenantId, actorId, 'originator', { entityId, currency: 'US' })).rejects.toBeInstanceOf(BadRequestException);
    expect(h.cases.create).not.toHaveBeenCalled();
  });

  it('rejects creates over the actor hourly budget before writing', async () => {
    const h = harness(sampleCase(), { actorHourlyCreates: 10, tenantHourlyCreates: 10, tenantLifetimeCases: 10 });
    await expect(h.service.create(tenantId, actorId, 'originator', { entityId, currency: 'USD' }))
      .rejects.toMatchObject({ status: 429 });
    expect(h.cases.create).not.toHaveBeenCalled();
    expect(h.audit.record).not.toHaveBeenCalled();
  });

  it('rejects creates over the tenant hourly budget before writing', async () => {
    const h = harness(sampleCase(), { actorHourlyCreates: 2, tenantHourlyCreates: 100, tenantLifetimeCases: 100 });
    await expect(h.service.create(tenantId, actorId, 'originator', { entityId, currency: 'USD' }))
      .rejects.toMatchObject({ status: 429 });
    expect(h.cases.create).not.toHaveBeenCalled();
    expect(h.audit.record).not.toHaveBeenCalled();
  });

  it('rejects creates at the durable tenant lifetime cap', async () => {
    const h = harness(sampleCase(), { actorHourlyCreates: 0, tenantHourlyCreates: 0, tenantLifetimeCases: 10_000 });
    await expect(h.service.create(tenantId, actorId, 'originator', { entityId, currency: 'USD' }))
      .rejects.toBeInstanceOf(ConflictException);
    expect(h.cases.create).not.toHaveBeenCalled();
    expect(h.audit.record).not.toHaveBeenCalled();
  });

  it('allows an analyst to move a draft case to documents_pending', async () => {
    const h = harness(sampleCase({ status: 'draft' }));
    const result = await h.service.updateStatus(tenantId, actorId, 'analyst', sampleCase().id, { status: 'documents_pending', version: 1 });
    expect(result.status).toBe('documents_pending');
    expect(h.audit.record).toHaveBeenCalledWith(tenantId, actorId, expect.objectContaining({ type: 'case.status_changed' }), tx);
  });

  it('rejects a status transition that skips the review workflow', async () => {
    const h = harness(sampleCase({ status: 'draft' }));
    await expect(h.service.updateStatus(tenantId, actorId, 'analyst', sampleCase().id, { status: 'approved', version: 1 })).rejects.toBeInstanceOf(BadRequestException);
    expect(h.cases.updateStatus).not.toHaveBeenCalled();
  });

  it('does not allow an originator to approve a case', async () => {
    const h = harness(sampleCase({ status: 'in_review' }));
    await expect(h.service.updateStatus(tenantId, actorId, 'originator', sampleCase().id, { status: 'approved', version: 1 })).rejects.toBeInstanceOf(ForbiddenException);
    expect(h.cases.updateStatus).not.toHaveBeenCalled();
  });

  it('allows a reviewer to approve an in-review case', async () => {
    const h = harness(sampleCase({ status: 'in_review' }));
    const result = await h.service.updateStatus(tenantId, actorId, 'reviewer', sampleCase().id, { status: 'approved', version: 1 });
    expect(result.status).toBe('approved');
  });

  it('rejects an optimistic concurrency conflict without recording an audit event', async () => {
    const h = harness(sampleCase({ version: 4 }));
    await expect(h.service.updateStatus(tenantId, actorId, 'analyst', sampleCase().id, { status: 'documents_pending', version: 1 })).rejects.toBeInstanceOf(ConflictException);
    expect(h.cases.updateStatus).not.toHaveBeenCalled();
    expect(h.audit.record).not.toHaveBeenCalled();
  });

  it('archives a case using soft delete and records an audit event', async () => {
    const h = harness();
    const result = await h.service.archive(tenantId, actorId, 'originator', sampleCase().id, 1);
    expect(result.deletedAt).not.toBeNull();
    expect(h.cases.softDelete).toHaveBeenCalledWith(tenantId, actorId, sampleCase().id, 1, tx);
    expect(h.audit.record).toHaveBeenCalledWith(tenantId, actorId, expect.objectContaining({ type: 'case.archived' }), tx);
  });

  it('scopes list operations to the trusted tenant argument', async () => {
    const h = harness();
    await h.service.list(tenantId, actorId, { limit: 20 });
    expect(h.cases.findByTenant).toHaveBeenCalledWith(tenantId, actorId, { limit: 20 }, tx);
  });
});
