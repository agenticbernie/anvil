import { describe, expect, it, jest } from '@jest/globals';
import type { TenantTransaction, UnitOfWork } from '../../../infrastructure/database/tenant-transaction.js';
import type { AuditEventRepository } from '../../audit/audit.types.js';
import type { ExtractionJobPayload, ExtractionRepository, LlmExtractionProvider } from './extraction.types.js';
import { ExtractionService } from './extraction.service.js';

const tenantId = '00000000-0000-4000-8000-000000000001';
const actorId = '00000000-0000-4000-8000-000000000011';
const caseId = '00000000-0000-4000-8000-000000000021';
const documentId = '00000000-0000-4000-8000-000000000031';
const documentVersionId = '00000000-0000-4000-8000-000000000041';
const processingJobId = '00000000-0000-4000-8000-000000000051';
const runId = '00000000-0000-4000-8000-000000000061';
const tx = {} as TenantTransaction;
const payload: ExtractionJobPayload = { tenantId, actorId, caseId, documentId, documentVersionId, processingJobId };
const candidate = { field_name: 'gpu_count', raw_value: '100 GPUs', normalized_value: 100, source_page: 2, confidence: 0.9 };

function fixture(providerResult: unknown = { facts: [candidate], modelName: 'fake-v1', promptTokens: null, completionTokens: null, costEstimate: null }) {
  const run = { id: runId, tenantId, caseId, documentVersionId, modelName: 'fake-v1', promptHash: 'a'.repeat(64), status: 'processing' as const, attemptCount: 1, lockExpiresAt: null };
  const repository = {
    findDocumentVersion: jest.fn(async () => ({ id: documentVersionId, tenantId, caseId, documentId, sourceTextCiphertext: Buffer.from('cipher'), sourceTextNonce: Buffer.alloc(12), sourceTextKeyVersion: 'v1', sourcePageCount: 3 })),
    findRunByInput: jest.fn(async () => null),
    beginRun: jest.fn(async () => ({ run, acquired: true })),
    insertFacts: jest.fn(async () => [{ id: '00000000-0000-4000-8000-000000000071' }]),
    markRunSucceeded: jest.fn(async () => undefined),
    markRunFailedValidation: jest.fn(async () => undefined),
    markRunRetryWait: jest.fn(async () => undefined),
    lockAndGetFactUpdateUsage: jest.fn(async () => ({ actorHourlyUpdates: 0, tenantHourlyUpdates: 0, tenantLifetimeUpdates: 0 })),
    getFact: jest.fn(async () => null),
    updateFact: jest.fn(async () => { throw new Error('mock fact update not configured'); }),
  } as unknown as ExtractionRepository;
  const provider = { extract: jest.fn(async () => providerResult) } as unknown as LlmExtractionProvider;
  const factCipher = {
    encrypt: jest.fn((_tenant: string, _fact: string, _field: string, value: unknown) => ({ encrypted: value })),
    decrypt: jest.fn((_tenant: string, _fact: string, _field: string, value: unknown) => value),
    fingerprint: jest.fn(() => 'b'.repeat(64)),
  };
  const audit = { record: jest.fn(async () => undefined) } as unknown as AuditEventRepository;
  const outbox = { create: jest.fn(async () => undefined) };
  const unitOfWork = { run: jest.fn(async (_scope: unknown, work: (transaction: TenantTransaction) => Promise<unknown>) => work(tx)) } as unknown as UnitOfWork;
  const textCipher = { decrypt: jest.fn(() => 'Schedule: 100 GPUs on page 2.') };
  const service = new ExtractionService(repository, provider, factCipher as never, textCipher, audit, outbox as never, unitOfWork, 'fake-v1');
  return { service, repository, provider, factCipher, textCipher, audit, outbox, unitOfWork, run };
}

describe('ExtractionService', () => {
  it('validates and persists facts with document provenance and audit events', async () => {
    const f = fixture();

    await expect(f.service.process(payload)).resolves.toMatchObject({ status: 'succeeded', factCount: 1 });

    expect(f.repository.insertFacts).toHaveBeenCalledWith(tenantId, actorId, runId, caseId, [expect.objectContaining({
      fieldName: 'gpu_count', sourcePage: 2, confidence: 0.9,
    })], tx);
    expect(f.repository.markRunSucceeded).toHaveBeenCalledWith(tenantId, actorId, runId, null, tx);
    expect(f.audit.record).toHaveBeenCalledWith(tenantId, actorId, expect.objectContaining({ type: 'fact.created' }), tx);
  });

  it('returns before text fetch or provider call when a completed run already exists', async () => {
    const f = fixture();
    (f.repository.beginRun as jest.Mock).mockResolvedValue({ run: { ...f.run, status: 'succeeded' }, acquired: false });

    await expect(f.service.process(payload)).resolves.toMatchObject({ status: 'already_processed' });

    expect(f.provider.extract).not.toHaveBeenCalled();
    expect(f.repository.insertFacts).not.toHaveBeenCalled();
  });

  it('marks invalid provider output for manual review without inserting facts', async () => {
    const f = fixture({ facts: [{ field_name: 'gpu_count', raw_value: '100', normalized_value: 100, confidence: 1.4 }], modelName: 'fake-v1', promptTokens: null, completionTokens: null, costEstimate: null });

    await expect(f.service.process(payload)).resolves.toMatchObject({ status: 'failed_validation' });

    expect(f.repository.markRunFailedValidation).toHaveBeenCalledWith(tenantId, actorId, runId, expect.any(String), tx);
    expect(f.repository.insertFacts).not.toHaveBeenCalled();
    expect(f.outbox.create).toHaveBeenCalledWith(tenantId, actorId, 'extraction.needs_manual_review', expect.objectContaining({ extractionRunId: runId }), tx);
  });

  it('records retry state and rethrows transient provider failures', async () => {
    const f = fixture();
    (f.provider.extract as jest.Mock).mockRejectedValue(new Error('upstream unavailable'));

    await expect(f.service.process(payload)).rejects.toThrow('upstream unavailable');

    expect(f.repository.markRunRetryWait).toHaveBeenCalledWith(tenantId, actorId, runId, tx);
  });

  it('records a safe before/after audit when an analyst verifies a fact', async () => {
    const f = fixture();
    const before = { id: 'fact-id', fieldName: 'gpu_count', normalizedValue: 100, reviewStatus: 'unverified' };
    const after = { ...before, reviewStatus: 'verified' };
    (f.repository.getFact as jest.Mock).mockResolvedValue(before);
    (f.repository.updateFact as jest.Mock).mockResolvedValue(after);

    await expect(f.service.updateFact(tenantId, actorId, before.id, { reviewStatus: 'verified' })).resolves.toEqual(after);

    expect(f.audit.record).toHaveBeenCalledWith(tenantId, actorId, expect.objectContaining({
      type: 'fact.verified', metadata: expect.objectContaining({ beforeHash: expect.any(String), afterHash: expect.any(String) }),
    }), tx);
  });

  it('rejects empty fact patches', async () => {
    const f = fixture();
    await expect(f.service.updateFact(tenantId, actorId, 'fact-id', {})).rejects.toThrow('At least one fact field');
    expect(f.repository.getFact).not.toHaveBeenCalled();
  });

  it('does not update a fact missing from the selected tenant', async () => {
    const f = fixture();
    (f.repository.getFact as jest.Mock).mockResolvedValue(null);
    await expect(f.service.updateFact(tenantId, actorId, 'fact-id', { reviewStatus: 'verified' })).rejects.toThrow('Fact not found');
    expect(f.repository.updateFact).not.toHaveBeenCalled();
  });

  it('rejects a fact update when the actor hourly budget is exhausted', async () => {
    const f = fixture();
    (f.repository.lockAndGetFactUpdateUsage as jest.Mock).mockResolvedValue({ actorHourlyUpdates: 10, tenantHourlyUpdates: 10, tenantLifetimeUpdates: 10 });
    await expect(f.service.updateFact(tenantId, actorId, 'fact-id', { reviewStatus: 'verified' })).rejects.toThrow('Fact review update hourly budget is exhausted.');
    expect(f.repository.getFact).not.toHaveBeenCalled();
    expect(f.repository.updateFact).not.toHaveBeenCalled();
    expect(f.audit.record).not.toHaveBeenCalled();
  });

  it('rejects a fact update when the tenant hourly budget is exhausted', async () => {
    const f = fixture();
    (f.repository.lockAndGetFactUpdateUsage as jest.Mock).mockResolvedValue({ actorHourlyUpdates: 0, tenantHourlyUpdates: 100, tenantLifetimeUpdates: 100 });
    await expect(f.service.updateFact(tenantId, actorId, 'fact-id', { reviewStatus: 'verified' })).rejects.toThrow('Fact review update hourly budget is exhausted.');
    expect(f.repository.getFact).not.toHaveBeenCalled();
    expect(f.audit.record).not.toHaveBeenCalled();
  });

  it('rejects a fact update after the tenant lifetime cap is reached', async () => {
    const f = fixture();
    (f.repository.lockAndGetFactUpdateUsage as jest.Mock).mockResolvedValue({ actorHourlyUpdates: 0, tenantHourlyUpdates: 0, tenantLifetimeUpdates: 100_000 });
    await expect(f.service.updateFact(tenantId, actorId, 'fact-id', { reviewStatus: 'verified' })).rejects.toThrow('Tenant fact review update limit reached.');
    expect(f.repository.getFact).not.toHaveBeenCalled();
    expect(f.repository.updateFact).not.toHaveBeenCalled();
    expect(f.audit.record).not.toHaveBeenCalled();
  });
});
