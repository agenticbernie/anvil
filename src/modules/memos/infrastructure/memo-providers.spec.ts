import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { CreditMemoSchema } from '../application/memo.schema.js';
import type { MemoGenerationInput } from '../application/memo.types.js';
import { FakeMemoProvider } from './fake-memo.provider.js';
import { OpenAiMemoProvider } from './openai-memo.provider.js';

const factId = '00000000-0000-4000-8000-000000000041';
const input: MemoGenerationInput = {
  tenantId: '00000000-0000-4000-8000-000000000001', actorId: '00000000-0000-4000-8000-000000000011',
  caseId: '00000000-0000-4000-8000-000000000021',
  facts: [{ id: factId, tenantId: '00000000-0000-4000-8000-000000000001', extractionRunId: '00000000-0000-4000-8000-000000000051', caseId: '00000000-0000-4000-8000-000000000021', fieldName: 'gpu_count', rawValue: '100 GPUs', normalizedValue: 100, sourcePage: 2, confidence: 0.9, reviewStatus: 'unverified', isCritical: false }],
};

afterEach(() => jest.restoreAllMocks());

describe('FakeMemoProvider', () => {
  it('returns deterministic structured content tied to source facts', async () => {
    const provider = new FakeMemoProvider(0);
    const first = await provider.generate(input);
    const second = await provider.generate(input);
    expect(first).toEqual(second);
    expect(CreditMemoSchema.safeParse(first).success).toBe(true);
    expect(first).toMatchObject({ financial_highlights: [{ field_name: 'gpu_count', source_fact_ids: [factId] }], recommendation: 'undetermined' });
  });
});

describe('CreditMemoSchema', () => {
  const valid = {
    borrower_overview: 'Evidence-based draft.', request_summary: 'Analyst review required.',
    financial_highlights: [{ field_name: 'gpu_count', summary: '100 units', source_fact_ids: [factId] }],
    risks: [], mitigants: [], recommendation: 'undetermined',
  };
  it('rejects invalid recommendations and unrecognized model output fields', () => {
    expect(CreditMemoSchema.safeParse({ ...valid, recommendation: 'approve' }).success).toBe(false);
    expect(CreditMemoSchema.safeParse({ ...valid, fabricated_score: 99 }).success).toBe(false);
  });
  it('requires source fact identifiers to have UUID format', () => {
    expect(CreditMemoSchema.safeParse({ ...valid, financial_highlights: [{ ...valid.financial_highlights[0], source_fact_ids: ['not-a-uuid'] }] }).success).toBe(false);
  });

  it.each([
    ['null envelope', null], ['array envelope', []], ['string envelope', 'memo'], ['missing overview', { ...valid, borrower_overview: undefined }],
    ['numeric overview', { ...valid, borrower_overview: 12 }], ['null recommendation', { ...valid, recommendation: null }],
    ['unknown root property', { ...valid, tenant_id: '00000000-0000-4000-8000-000000000001' }],
    ['unknown highlight property', { ...valid, financial_highlights: [{ ...valid.financial_highlights[0], confidence: 0.9 }] }],
  ])('rejects malformed memo envelope: %s', (_case, candidate) => {
    expect(CreditMemoSchema.safeParse(candidate).success).toBe(false);
  });

  it.each([
    ['empty', ''], ['one character', 'a'], ['uppercase', 'Revenue'], ['leading digit', '1revenue'],
    ['hyphen', 'annual-revenue'], ['space', 'annual revenue'], ['unicode', 'ånual_revenue'],
    ['punctuation', 'revenue!'], ['overlong', 'a'.repeat(65)], ['missing prefix', '_revenue'],
  ])('rejects invalid extracted field names in memo evidence: %s', (_case, fieldName) => {
    const candidate = { ...valid, financial_highlights: [{ field_name: fieldName, summary: 'Evidence', source_fact_ids: [factId] }] };
    expect(CreditMemoSchema.safeParse(candidate).success).toBe(false);
  });

  it.each([
    ['empty identifier', ''], ['plain text', 'fact-1'], ['too short', '00000000-0000-0000-0000-00000000000'],
    ['wrong separators', '00000000000000000000000000000000'], ['suffix whitespace', `${factId} `],
    ['prefix whitespace', ` ${factId}`], ['non-hex identifier', '00000000-0000-4000-8000-0000000000zz'],
  ])('rejects malformed provenance fact identifier: %s', (_case, id) => {
    const candidate = { ...valid, financial_highlights: [{ ...valid.financial_highlights[0], source_fact_ids: [id] }] };
    expect(CreditMemoSchema.safeParse(candidate).success).toBe(false);
  });

  it.each([
    ['overview', { borrower_overview: 'x'.repeat(8_001) }], ['request summary', { request_summary: 'x'.repeat(4_001) }],
    ['highlight summary', { financial_highlights: [{ ...valid.financial_highlights[0], summary: 'x'.repeat(2_001) }] }],
    ['risk text', { risks: ['x'.repeat(2_001)] }], ['mitigant text', { mitigants: ['x'.repeat(2_001)] }],
  ])('rejects memo text over the documented size: %s', (_case, change) => {
    expect(CreditMemoSchema.safeParse({ ...valid, ...change }).success).toBe(false);
  });

  it.each([
    ['financial highlights', { financial_highlights: Array.from({ length: 51 }, () => valid.financial_highlights[0]) }],
    ['source fact references', { financial_highlights: [{ ...valid.financial_highlights[0], source_fact_ids: Array.from({ length: 51 }, () => factId) }] }],
    ['risks', { risks: Array.from({ length: 51 }, () => 'Risk') }],
    ['mitigants', { mitigants: Array.from({ length: 51 }, () => 'Mitigant') }],
  ])('rejects arrays over the documented limit: %s', (_case, change) => {
    expect(CreditMemoSchema.safeParse({ ...valid, ...change }).success).toBe(false);
  });
});

describe('OpenAiMemoProvider', () => {
  it('requests JSON-object responses and excludes tenant and actor identifiers from the prompt', async () => {
    const memo = { borrower_overview: 'Draft', request_summary: 'Review', financial_highlights: [], risks: [], mitigants: [], recommendation: 'undetermined' };
    const fetcher = jest.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(memo) } }] }), { status: 200 }));
    const provider = new OpenAiMemoProvider({ apiKey: 'synthetic-test-key', model: 'configured-model', timeoutMs: 2_000, fetcher });
    await expect(provider.generate(input)).resolves.toEqual(memo);
    const request = fetcher.mock.calls[0]?.[1];
    const body = JSON.parse(String(request?.body)) as { response_format: { type: string }; messages: { content: string }[] };
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.messages[1]?.content).not.toContain(input.tenantId);
    expect(body.messages[1]?.content).not.toContain(input.actorId);
  });

  it('throws on upstream failures rather than silently creating an empty memo', async () => {
    const fetcher = jest.fn<typeof fetch>().mockResolvedValue(new Response('failed', { status: 503 }));
    const provider = new OpenAiMemoProvider({ apiKey: 'synthetic-test-key', model: 'configured-model', timeoutMs: 2_000, fetcher });
    await expect(provider.generate(input)).rejects.toThrow('OpenAI memo request failed');
  });

  it('propagates an API timeout so the memo worker records failure and BullMQ can retry', async () => {
    const fetcher = ((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    })) as typeof fetch;
    const provider = new OpenAiMemoProvider({ apiKey: 'synthetic-test-key', model: 'configured-model', timeoutMs: 5, fetcher });

    await expect(provider.generate(input)).rejects.toMatchObject({ name: 'TimeoutError' });
  });
});
