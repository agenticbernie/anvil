import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from '@jest/globals';
import { UpdateFactDto } from './facts.dto.js';

describe('UpdateFactDto validation', () => {
  it('accepts a scalar normalized JSON value and a valid review status', async () => {
    const dto = plainToInstance(UpdateFactDto, { normalizedValue: 50_000, reviewStatus: 'verified' });
    expect(await validate(dto)).toHaveLength(0);
  });

  it('accepts null as an explicit normalized JSON value', async () => {
    const dto = plainToInstance(UpdateFactDto, { normalizedValue: null });
    expect(await validate(dto)).toHaveLength(0);
  });

  it('rejects unsupported review statuses', async () => {
    const dto = plainToInstance(UpdateFactDto, { reviewStatus: 'approved' });
    expect(await validate(dto)).not.toHaveLength(0);
  });

  it('rejects executable or non-JSON normalized values', async () => {
    const dto = plainToInstance(UpdateFactDto, { normalizedValue: () => 'secret' });
    expect(await validate(dto)).not.toHaveLength(0);
  });

  const deeplyNested: unknown = (() => {
    let value: unknown = 'leaf';
    for (let depth = 0; depth < 9; depth += 1) value = { child: value };
    return value;
  })();
  const depthBoundary: unknown = (() => {
    let value: unknown = 'leaf';
    for (let depth = 0; depth < 8; depth += 1) value = { child: value };
    return value;
  })();
  const oversizedRecord = Object.fromEntries(Array.from({ length: 501 }, (_, index) => [`key_${index}`, index]));

  it.each([
    ['bigint', 1n], ['symbol', Symbol('value')], ['NaN', Number.NaN], ['infinity', Number.POSITIVE_INFINITY],
    ['date object', new Date()], ['map object', new Map([['key', 'value']])], ['set object', new Set([1])],
    ['custom prototype', Object.create({ inherited: 'value' })], ['overlong string', 'x'.repeat(20_001)],
    ['overdeep object', deeplyNested], ['oversized array', Array.from({ length: 501 }, (_, index) => index)],
    ['oversized object', oversizedRecord], ['overlong object key', { ['k'.repeat(129)]: 'value' }],
  ])('rejects a non-JSON or unbounded normalized value: %s', async (_case, normalizedValue) => {
    const dto = Object.assign(new UpdateFactDto(), { normalizedValue });
    expect(await validate(dto)).not.toHaveLength(0);
  });

  it.each([
    ['string', 'audited value'], ['finite number', 0], ['boolean', false], ['array', [1, 'two', null]],
    ['plain object', { amount: 50_000, currency: 'USD' }], ['empty object', {}], ['empty array', []],
    ['depth boundary', depthBoundary],
  ])('accepts bounded JSON review values: %s', async (_case, normalizedValue) => {
    const dto = Object.assign(new UpdateFactDto(), { normalizedValue });
    expect(await validate(dto)).toHaveLength(0);
  });
});
