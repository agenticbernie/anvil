import type { LlmMemoProvider, MemoGenerationInput } from '../application/memo.types.js';

export class FakeMemoProvider implements LlmMemoProvider {
  constructor(private readonly delayMs = 50) {
    if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 5_000) throw new RangeError('Fake memo delay is out of range.');
  }

  async generate(input: MemoGenerationInput): Promise<unknown> {
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    return {
      borrower_overview: 'Deterministic test draft. Confirm all details against source evidence.',
      request_summary: 'Request details require analyst confirmation.',
      financial_highlights: input.facts.map((fact) => ({
        field_name: fact.fieldName,
        summary: `Value requires review; source page ${fact.sourcePage}.`,
        source_fact_ids: [fact.id],
      })),
      risks: [],
      mitigants: [],
      recommendation: 'undetermined',
    };
  }
}
