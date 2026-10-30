import { describe, expect, it } from '@jest/globals';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { AppModule } from '../../app.module.js';
import { CasesModule } from '../cases/cases.module.js';
import { ExtractionModule } from '../extraction/extraction.module.js';
import { IdempotencyModule } from './idempotency.module.js';
import { MemosModule } from '../memos/memos.module.js';

function moduleImports(target: object): unknown[] {
  return Reflect.getMetadata(MODULE_METADATA.IMPORTS, target) ?? [];
}

describe('IdempotencyModule process boundary', () => {
  it('is registered at the HTTP application boundary', () => {
    expect(moduleImports(AppModule)).toContain(IdempotencyModule);
  });

  it.each([CasesModule, ExtractionModule, MemosModule])('%s does not pull the web HMAC key into worker dependencies', (featureModule) => {
    expect(moduleImports(featureModule)).not.toContain(IdempotencyModule);
  });
});
