import { ConflictException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, jest } from '@jest/globals';
import type { TenantTransaction, UnitOfWork } from '../../../infrastructure/database/tenant-transaction.js';
import type { AuditEventRepository } from '../../audit/audit.types.js';
import type { CaseRepository } from '../../cases/application/case.types.js';
import type { ExtractedFact, ExtractionRepository } from '../../extraction/application/extraction.types.js';
import { FakeMemoProvider } from '../infrastructure/fake-memo.provider.js';
import type { MemoContentCipher, MemoRepository } from './memo.types.js';
import { MemoService } from './memo.service.js';

const tenantId = '00000000-0000-4000-8000-000000000001';
const actorId = '00000000-0000-4000-8000-000000000011';
const caseId = '00000000-0000-4000-8000-000000000021';
const memoId = '00000000-0000-4000-8000-000000000031';
const factId = '00000000-0000-4000-8000-000000000041';
const tx = {} as TenantTransaction;
const fact: ExtractedFact = {
  id: factId, tenantId, extractionRunId: '00000000-0000-4000-8000-000000000051', caseId,
  fieldName: 'gpu_count', rawValue: '100 GPU units', normalizedValue: 100, sourcePage: 2,
  confidence: 0.9, reviewStatus: 'unverified', isCritical: false,
};

function fixture() {
  const memos = {
    claimGeneration: jest.fn(async () => ({ memoId, versionNumber: 1, acquired: true })),
    markDraft: jest.fn(async () => undefined), markFailed: jest.fn(async () => undefined),
    getById: jest.fn(async () => ({ id: memoId, tenantId, caseId, versionNumber: 1, inputHash: 'a'.repeat(64), status: 'draft', content: null, approvedAt: null })),
    approve: jest.fn(async () => ({ id: memoId, tenantId, caseId, versionNumber: 1, inputHash: 'a'.repeat(64), status: 'approved', content: null, approvedAt: new Date().toISOString() })),
  } as unknown as MemoRepository;
  const facts = {
    listFactsForCase: jest.fn(async () => [fact]),
    lockCriticalFactsForCase: jest.fn(async () => undefined),
    countUnresolvedCriticalConflicts: jest.fn(async () => 0),
  } as unknown as ExtractionRepository;
  const cases = { findById: jest.fn(async () => ({ id: caseId })) } as unknown as CaseRepository;
  const provider = new FakeMemoProvider(0);
  const cipher = {
    encrypt: jest.fn((_tenant: string, _memo: string, _field: string, value: unknown) => ({ encrypted: value })),
    decrypt: jest.fn(), fingerprint: jest.fn(() => 'c'.repeat(64)),
  } as unknown as MemoContentCipher;
  const outbox = { create: jest.fn(async () => undefined) };
  const audit = { record: jest.fn(async () => undefined) } as unknown as AuditEventRepository;
  const unitOfWork = { run: jest.fn(async (_scope: unknown, work: (transaction: TenantTransaction) => Promise<unknown>) => work(tx)) } as unknown as UnitOfWork;
  const service = new MemoService(memos, provider, cipher, facts, cases, outbox as never, audit, unitOfWork);
  return { service, memos, facts, cases, provider, cipher, outbox, audit, unitOfWork };
}

describe('MemoService', () => {
  it('creates a transactional outbox request and audit event without doing LLM work inline', async () => {
    const f = fixture();

    const response = await f.service.requestGeneration(tenantId, actorId, caseId);

    expect(response).toMatchObject({ accepted: true, jobId: expect.any(String) });
    expect(f.outbox.create).toHaveBeenCalledWith(tenantId, actorId, 'memo.generate.requested', { caseId, generationKey: response.jobId }, tx);
    expect(f.audit.record).toHaveBeenCalledWith(tenantId, actorId, expect.objectContaining({ type: 'memo.generation_requested' }), tx);
    expect(f.provider).toBeInstanceOf(FakeMemoProvider);
  });

  it('generates a schema-valid draft and records its audit event', async () => {
    const f = fixture();

    await expect(f.service.generate({ tenantId, actorId, caseId, generationKey: '00000000-0000-4000-8000-000000000061' }))
      .resolves.toMatchObject({ status: 'draft', memoId });

    expect(f.memos.claimGeneration).toHaveBeenCalledWith(tenantId, actorId, caseId, expect.stringMatching(/^[a-f0-9]{64}$/), tx);
    expect(f.memos.markDraft).toHaveBeenCalledWith(tenantId, actorId, memoId, expect.objectContaining({ encrypted: expect.any(Object) }), tx);
    expect(f.audit.record).toHaveBeenCalledWith(tenantId, actorId, expect.objectContaining({ type: 'memo.generated' }), tx);
  });

  it('skips provider calls when a memo version already exists for the fact snapshot', async () => {
    const f = fixture();
    const providerSpy = jest.spyOn(f.provider, 'generate');
    (f.memos.claimGeneration as jest.Mock).mockResolvedValue({ memoId, versionNumber: 1, acquired: false });

    await expect(f.service.generate({ tenantId, actorId, caseId, generationKey: memoId })).resolves.toEqual({ status: 'already_exists', memoId });

    expect(providerSpy).not.toHaveBeenCalled();
    expect(f.memos.markDraft).not.toHaveBeenCalled();
  });

  it('rejects memo references to facts outside the tenant case snapshot', async () => {
    const f = fixture();
    const invalid = {
      borrower_overview: 'Draft', request_summary: 'Draft', financial_highlights: [{ field_name: 'gpu_count', summary: '100', source_fact_ids: ['00000000-0000-4000-8000-000000000099'] }],
      risks: [], mitigants: [], recommendation: 'undetermined',
    };
    (f.provider as unknown as { generate: jest.Mock }).generate = jest.fn(async () => invalid);

    await expect(f.service.generate({ tenantId, actorId, caseId, generationKey: memoId })).rejects.toThrow('fact provenance validation');

    expect(f.memos.markFailed).toHaveBeenCalledWith(tenantId, actorId, memoId, tx);
    expect(f.memos.markDraft).not.toHaveBeenCalled();
  });

  it('requires an override reason before approving with unresolved critical conflicts', async () => {
    const f = fixture();
    (f.facts.countUnresolvedCriticalConflicts as jest.Mock).mockResolvedValue(2);

    await expect(f.service.approve(tenantId, actorId, memoId)).rejects.toBeInstanceOf(ConflictException);

    expect(f.facts.lockCriticalFactsForCase).toHaveBeenCalledWith(tenantId, actorId, caseId, tx);
    expect((f.facts.lockCriticalFactsForCase as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
      (f.facts.countUnresolvedCriticalConflicts as jest.Mock).mock.invocationCallOrder[0]!,
    );
    expect(f.memos.approve).not.toHaveBeenCalled();
    expect(f.audit.record).not.toHaveBeenCalled();
  });

  it('stores only encrypted override content and audits memo approval', async () => {
    const f = fixture();
    (f.facts.countUnresolvedCriticalConflicts as jest.Mock).mockResolvedValue(1);

    await expect(f.service.approve(tenantId, actorId, memoId, 'Reviewed the conflicting revenue evidence.')).resolves.toMatchObject({ status: 'approved' });

    expect(f.cipher.encrypt).toHaveBeenCalledWith(tenantId, memoId, 'override_reason', 'Reviewed the conflicting revenue evidence.');
    expect(f.memos.approve).toHaveBeenCalledWith(tenantId, actorId, memoId, expect.objectContaining({ encrypted: expect.any(String) }), tx);
    expect(f.audit.record).toHaveBeenCalledWith(tenantId, actorId, expect.objectContaining({
      type: 'memo.approved', metadata: expect.objectContaining({ overrideUsed: true, overrideReasonHash: expect.any(String) }),
    }), tx);
  });

  it('does not create an outbox event for a case outside the active tenant', async () => {
    const f = fixture();
    (f.cases.findById as jest.Mock).mockResolvedValue(null);

    await expect(f.service.requestGeneration(tenantId, actorId, caseId)).rejects.toBeInstanceOf(NotFoundException);
    expect(f.outbox.create).not.toHaveBeenCalled();
  });
});
