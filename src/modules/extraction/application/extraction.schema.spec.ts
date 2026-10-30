import { describe, expect, it } from '@jest/globals';
import { ExtractionResultSchema } from './extraction.schema.js';

const validFact = {
  field_name: 'annual_revenue',
  raw_value: '$50,000',
  normalized_value: { amount: 50000, currency: 'USD' },
  source_page: 2,
  confidence: 0.91,
};

describe('ExtractionResultSchema', () => {
  it('accepts structured facts with page and confidence provenance', () => {
    expect(ExtractionResultSchema.safeParse({ facts: [validFact] }).success).toBe(true);
  });

  it('rejects a fact without a source page', () => {
    const { source_page: _sourcePage, ...fact } = validFact;
    expect(ExtractionResultSchema.safeParse({ facts: [fact] }).success).toBe(false);
  });

  it('rejects confidence outside the inclusive zero-to-one range', () => {
    expect(ExtractionResultSchema.safeParse({ facts: [{ ...validFact, confidence: 1.01 }] }).success).toBe(false);
  });

  it('rejects non-positive page numbers', () => {
    expect(ExtractionResultSchema.safeParse({ facts: [{ ...validFact, source_page: 0 }] }).success).toBe(false);
  });

  it('rejects malformed normalized JSON values', () => {
    expect(ExtractionResultSchema.safeParse({ facts: [{ ...validFact, normalized_value: Number.NaN }] }).success).toBe(false);
  });

  it('rejects unrecognized keys instead of silently accepting model output drift', () => {
    expect(ExtractionResultSchema.safeParse({ facts: [validFact], tenant_id: 'attacker-controlled' }).success).toBe(false);
  });

  it('accepts an empty fact list when the document contains no supported evidence', () => {
    expect(ExtractionResultSchema.safeParse({ facts: [] }).success).toBe(true);
  });

  it.each([
    ['empty', ''], ['one character', 'a'], ['uppercase', 'Annual_revenue'], ['starts with a digit', '1revenue'],
    ['hyphen', 'annual-revenue'], ['space', 'annual revenue'], ['leading space', ' annual_revenue'],
    ['trailing space', 'annual_revenue '], ['unicode letter', 'ånual_revenue'], ['punctuation', 'revenue!'],
    ['over 64 characters', 'a'.repeat(65)], ['empty segment is allowed only after a valid prefix', 'x'],
  ])('rejects malformed field names: %s', (_case, fieldName) => {
    expect(ExtractionResultSchema.safeParse({ facts: [{ ...validFact, field_name: fieldName }] }).success).toBe(false);
  });

  it.each([
    ['negative page', -1], ['zero page', 0], ['fractional page', 1.5], ['page above limit', 1_000_001],
    ['NaN page', Number.NaN], ['infinite page', Number.POSITIVE_INFINITY],
    ['negative confidence', -0.001], ['confidence above one', 1.001], ['NaN confidence', Number.NaN],
    ['infinite confidence', Number.POSITIVE_INFINITY], ['negative infinite confidence', Number.NEGATIVE_INFINITY],
    ['string confidence', '0.9'], ['null confidence', null], ['boolean confidence', true],
  ])('rejects invalid provenance metadata: %s', (_case, value) => {
    const sourcePage = String(_case).includes('page');
    const fact = sourcePage ? { ...validFact, source_page: value } : { ...validFact, confidence: value };
    expect(ExtractionResultSchema.safeParse({ facts: [fact] }).success).toBe(false);
  });

  const deeplyNested: unknown = (() => {
    let value: unknown = 'leaf';
    for (let depth = 0; depth < 10; depth += 1) value = { child: value };
    return value;
  })();
  const oversizedRecord = Object.fromEntries(Array.from({ length: 501 }, (_, index) => [`key_${index}`, index]));
  const oversizedArray = Array.from({ length: 501 }, (_, index) => index);

  it.each([
    ['overlong string', 'x'.repeat(20_001)], ['overdeep object', deeplyNested],
    ['oversized object', oversizedRecord], ['oversized array', oversizedArray],
  ])('rejects resource-heavy JSON values: %s', (_case, candidate) => {
    expect(ExtractionResultSchema.safeParse({ facts: [{ ...validFact, normalized_value: candidate }] }).success).toBe(false);
  });

  it.each([
    ['null root', null], ['array root', []], ['string root', 'facts'], ['missing facts', {}],
    ['facts is null', { facts: null }], ['facts is an object', { facts: {} }],
  ])('rejects malformed extraction envelopes: %s', (_case, envelope) => {
    expect(ExtractionResultSchema.safeParse(envelope).success).toBe(false);
  });

  it.each([
    ['first page', 1], ['last allowed page', 1_000_000],
  ])('accepts inclusive source page boundary: %s', (_case, sourcePage) => {
    expect(ExtractionResultSchema.safeParse({ facts: [{ ...validFact, source_page: sourcePage }] }).success).toBe(true);
  });

  it.each([
    ['zero confidence', 0], ['full confidence', 1],
  ])('accepts inclusive confidence boundary: %s', (_case, confidence) => {
    expect(ExtractionResultSchema.safeParse({ facts: [{ ...validFact, confidence }] }).success).toBe(true);
  });

  it('accepts the maximum documented number of facts', () => {
    const facts = Array.from({ length: 250 }, (_, index) => ({ ...validFact, source_page: index + 1 }));
    expect(ExtractionResultSchema.safeParse({ facts }).success).toBe(true);
  });

  it('rejects one fact over the documented batch limit', () => {
    const facts = Array.from({ length: 251 }, () => validFact);
    expect(ExtractionResultSchema.safeParse({ facts }).success).toBe(false);
  });
});
