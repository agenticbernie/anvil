import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CASE_STATUSES, type CaseStatus, type CreditCase } from '../application/case.types.js';

export class CreateCaseDto {
  @ApiProperty({ format: 'uuid', description: 'Existing legal entity identifier.' })
  @IsUUID('4')
  entityId!: string;

  @ApiProperty({ example: 'USD', minLength: 3, maxLength: 3 })
  @IsString()
  @Matches(/^[A-Z]{3}$/)
  currency!: string;
}

export class ListCasesQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({ description: 'Opaque cursor from the previous response.' })
  @IsOptional()
  @IsString()
  cursor?: string;
}

export class UpdateCaseDto {
  @ApiProperty({ enum: CASE_STATUSES })
  @IsIn(CASE_STATUSES)
  status!: CaseStatus;

  @ApiProperty({ minimum: 1, description: 'Expected case version for optimistic concurrency.' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  version!: number;
}

export class ArchiveCaseDto {
  @ApiProperty({ minimum: 1, description: 'Expected case version for optimistic concurrency.' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  version!: number;
}

export class CreditCaseResponseDto {
  @ApiProperty({ format: 'uuid' }) declare id: string;
  @ApiProperty({ format: 'uuid' }) declare tenantId: string;
  @ApiProperty({ format: 'uuid' }) declare entityId: string;
  @ApiProperty() declare caseNumber: string;
  @ApiProperty({ enum: CASE_STATUSES }) declare status: CaseStatus;
  @ApiProperty({ example: 'USD' }) declare currency: string;
  @ApiProperty({ minimum: 1 }) declare version: number;
  @ApiProperty({ format: 'date-time' }) declare createdAt: string;
  @ApiProperty({ format: 'date-time' }) declare updatedAt: string;
  @ApiProperty({ format: 'date-time', nullable: true }) declare deletedAt: string | null;
  @ApiPropertyOptional({ format: 'uuid', description: 'Latest processing job to poll while the case is processing.', example: '00000000-0000-4000-8000-000000000061' }) declare currentJobId?: string;
}

export class CasePageResponseDto {
  @ApiProperty({ type: [CreditCaseResponseDto] }) declare items: CreditCase[];
  @ApiProperty({ type: String, nullable: true, description: 'Cursor to fetch the next page.' }) declare nextCursor: string | null;
}
