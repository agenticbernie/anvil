import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { ExtractionResultSchema } from '../application/extraction.schema.js';
import type { ExtractionInput } from '../application/extraction.types.js';
import { FakeExtractionProvider } from './fake-extraction.provider.js';
import { OpenAiExtractionProvider } from './openai-extraction.provider.js';

const input: ExtractionInput = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  actorId: '00000000-0000-4000-8000-000000000011',
  caseId: '00000000-0000-4000-8000-000000000021',
  documentVersionId: '00000000-0000-4000-8000-000000000031',
  text: 'The audited schedule reports annual revenue of USD 50,000 and 100 GPU units.',
};

afterEach(() => jest.restoreAllMocks());

describe('FakeExtractionProvider', () => {
  it('returns deterministic, schema-valid facts with provenance', async () => {
    const first = await new FakeExtractionProvider(0).extract(input);
    const second = await new FakeExtractionProvider(0).extract(input);

    expect(first).toEqual(second);
    expect(ExtractionResultSchema.safeParse({ facts: first.facts }).success).toBe(true);
    expect(first.facts).toEqual([
      { field_name: 'annual_revenue', raw_value: 'USD 50,000', normalized_value: { amount: 50000, currency: 'USD' }, source_page: 1, confidence: 0.95 },
      { field_name: 'gpu_count', raw_value: '100 GPU units', normalized_value: 100, source_page: 1, confidence: 0.9 },
    ]);
  });
});

describe('OpenAiExtractionProvider', () => {
  it('requests JSON-object output and parses the response without exposing credentials', async () => {
    const fetcher = jest.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      model: 'configured-model',
      choices: [{ message: { content: JSON.stringify({ facts: [{
        field_name: 'gpu_count', raw_value: '100', normalized_value: 100, source_page: 3, confidence: 0.88,
      }] }) } }],
      usage: { prompt_tokens: 12, completion_tokens: 9 },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const provider = new OpenAiExtractionProvider({ apiKey: 'synthetic-test-key', model: 'configured-model', timeoutMs: 2_000, fetcher });

    const result = await provider.extract(input);
    const request = fetcher.mock.calls[0]?.[1];
    const body = JSON.parse(String(request?.body)) as { response_format: { type: string }; model: string; messages: unknown[] };

    expect(result.facts).toEqual([{ field_name: 'gpu_count', raw_value: '100', normalized_value: 100, source_page: 3, confidence: 0.88 }]);
    expect(body).toMatchObject({ model: 'configured-model', response_format: { type: 'json_object' } });
    expect(request?.headers).toMatchObject({ authorization: 'Bearer synthetic-test-key' });
  });

  it('returns an invalid candidate for malformed JSON so the worker can mark manual review', async () => {
    const fetcher = jest.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: '{not-json' } }],
    }), { status: 200 }));
    const provider = new OpenAiExtractionProvider({ apiKey: 'synthetic-test-key', model: 'configured-model', timeoutMs: 2_000, fetcher });

    await expect(provider.extract(input)).resolves.toMatchObject({ facts: null });
  });

  it('throws on API failures instead of swallowing transient errors', async () => {
    const fetcher = jest.fn<typeof fetch>().mockResolvedValue(new Response('unavailable', { status: 503 }));
    const provider = new OpenAiExtractionProvider({ apiKey: 'synthetic-test-key', model: 'configured-model', timeoutMs: 2_000, fetcher });

    await expect(provider.extract(input)).rejects.toThrow('OpenAI extraction request failed');
  });

  it('propagates an API timeout so the worker can persist retry state', async () => {
    const fetcher = ((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    })) as typeof fetch;
    const provider = new OpenAiExtractionProvider({ apiKey: 'synthetic-test-key', model: 'configured-model', timeoutMs: 5, fetcher });

    await expect(provider.extract(input)).rejects.toMatchObject({ name: 'TimeoutError' });
  });
});
