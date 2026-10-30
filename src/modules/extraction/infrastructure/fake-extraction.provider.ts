import type { ExtractionInput, ExtractionResult, LlmExtractionProvider } from '../application/extraction.types.js';

export class FakeExtractionProvider implements LlmExtractionProvider {
  constructor(private readonly delayMs = 50) {
    if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 5_000) throw new RangeError('Fake extraction delay is out of range.');
  }

  async extract(_input: ExtractionInput): Promise<ExtractionResult> {
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    return {
      facts: [
        { field_name: 'annual_revenue', raw_value: 'USD 50,000', normalized_value: { amount: 50_000, currency: 'USD' }, source_page: 1, confidence: 0.95 },
        { field_name: 'gpu_count', raw_value: '100 GPU units', normalized_value: 100, source_page: 1, confidence: 0.9 },
      ],
      modelName: 'fake-extraction-v1',
      promptTokens: null,
      completionTokens: null,
      costEstimate: null,
    };
  }
}
