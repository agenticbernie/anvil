import { ValidationPipe } from '@nestjs/common';
import { describe, expect, it } from '@jest/globals';
import { CreateCaseDto, UpdateCaseDto } from './case.dto.js';

const entityId = '00000000-0000-4000-8000-000000000003';
const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true });

describe('case request DTO validation', () => {
  it('accepts a valid case request', async () => {
    const result = await pipe.transform({ entityId, currency: 'USD' }, { type: 'body', metatype: CreateCaseDto });
    expect(result).toEqual({ entityId, currency: 'USD' });
  });

  it('rejects a client supplied tenantId instead of silently trusting it', async () => {
    await expect(pipe.transform({ entityId, currency: 'USD', tenantId: '00000000-0000-4000-8000-000000000009' }, { type: 'body', metatype: CreateCaseDto }))
      .rejects.toMatchObject({ status: 400 });
  });

  it('rejects non-ISO currency values', async () => {
    await expect(pipe.transform({ entityId, currency: 'usd' }, { type: 'body', metatype: CreateCaseDto }))
      .rejects.toMatchObject({ status: 400 });
  });

  it('rejects transitions outside the allowed case statuses', async () => {
    await expect(pipe.transform({ status: 'deleted', version: 1 }, { type: 'body', metatype: UpdateCaseDto }))
      .rejects.toMatchObject({ status: 400 });
  });
});
