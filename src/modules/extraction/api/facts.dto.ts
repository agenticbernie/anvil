import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional, Validate, ValidateIf } from 'class-validator';
import type { ValidationArguments, ValidatorConstraintInterface } from 'class-validator';
import { ValidatorConstraint } from 'class-validator';
import type { ExtractedFact } from '../application/extraction.types.js';

export const FACT_REVIEW_STATUSES = ['unverified', 'verified', 'needs_evidence', 'conflict', 'rejected'] as const;

export class ListFactsQueryDto {
  @ApiPropertyOptional({ enum: FACT_REVIEW_STATUSES, description: 'Return only facts with this review status.' })
  @IsOptional()
  @IsIn(FACT_REVIEW_STATUSES)
  review_status?: (typeof FACT_REVIEW_STATUSES)[number];
}

@ValidatorConstraint({ name: 'isJsonValue', async: false })
export class IsJsonValueConstraint implements ValidatorConstraintInterface {
  validate(value: unknown, _args: ValidationArguments): boolean { return isJsonValue(value, 0); }
  defaultMessage(): string { return 'normalizedValue must be a bounded JSON value.'; }
}

export class UpdateFactDto {
  @ApiPropertyOptional({ description: 'Normalized JSON value; plaintext is encrypted before database persistence.', oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }, { type: 'object' }, { type: 'array' }, { type: 'null' }] })
  @IsOptional()
  @Validate(IsJsonValueConstraint)
  normalizedValue?: unknown;

  @ApiPropertyOptional({ enum: FACT_REVIEW_STATUSES })
  @IsOptional()
  @IsIn(FACT_REVIEW_STATUSES)
  reviewStatus?: (typeof FACT_REVIEW_STATUSES)[number];

  @ApiPropertyOptional({ type: Boolean, default: false, description: 'Marks whether this fact is critical for memo review and conflict overrides. Omitted updates preserve the current value.' })
  @ValidateIf((_object, value) => value !== undefined)
  @IsBoolean()
  is_critical?: boolean;
}

export class ExtractedFactResponseDto {
  @ApiProperty({ format: 'uuid' }) declare id: string;
  @ApiProperty({ format: 'uuid', description: 'Tenant that owns this fact.' }) declare tenantId: string;
  @ApiProperty({ format: 'uuid' }) declare extractionRunId: string;
  @ApiProperty({ format: 'uuid' }) declare caseId: string;
  @ApiProperty() declare fieldName: string;
  @ApiProperty({ oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }, { type: 'object', additionalProperties: true }, { type: 'array', items: {} }, { type: 'null' }] }) declare rawValue: unknown;
  @ApiProperty({ oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }, { type: 'object', additionalProperties: true }, { type: 'array', items: {} }, { type: 'null' }] }) declare normalizedValue: unknown;
  @ApiProperty({ minimum: 1 }) declare sourcePage: number;
  @ApiProperty({ minimum: 0, maximum: 1 }) declare confidence: number;
  @ApiProperty({ enum: FACT_REVIEW_STATUSES }) declare reviewStatus: ExtractedFact['reviewStatus'];
  @ApiProperty({ type: Boolean, default: false, description: 'Backward-compatible camelCase criticality flag.' }) declare isCritical: boolean;
  @ApiProperty({ type: Boolean, default: false, description: 'Whether this fact is critical for memo review and conflict overrides.' }) declare is_critical: boolean;
}

function isJsonValue(value: unknown, depth: number): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return typeof value !== 'string' || value.length <= 20_000;
  if (typeof value === 'number') return Number.isFinite(value);
  if (depth >= 8) return false;
  if (Array.isArray(value)) return value.length <= 500 && value.every((entry) => isJsonValue(entry, depth + 1));
  if (typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  return entries.length <= 500 && entries.every(([key, entry]) => key.length <= 128 && isJsonValue(entry, depth + 1));
}
