import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import type { CreditMemoContent } from '../application/memo.schema.js';
import type { MemoVersion } from '../application/memo.types.js';

export class ApproveMemoDto {
  @ApiPropertyOptional({ name: 'override_reason', minLength: 1, maxLength: 1000, description: 'Required when unresolved critical conflicts remain.' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  override_reason?: string;
}

export class RequestMemoGenerationDto {
  @ApiPropertyOptional({ name: 'override_reason', minLength: 1, maxLength: 1000, description: 'Required when this case has unresolved critical facts with review_status=conflict.' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  override_reason?: string;
}

export class RejectMemoDto {
  @ApiProperty({ minLength: 1, maxLength: 1000, description: 'Reason for rejecting this draft. Stored encrypted and audited by hash.' })
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  reason!: string;
}

export class MemoAcceptedResponseDto {
  @ApiProperty({ enum: [true] }) accepted!: true;
  @ApiProperty({ format: 'uuid', description: 'Outbox generation key returned as the asynchronous job ID.' }) jobId!: string;
}

export class MemoVersionResponseDto {
  @ApiProperty({ format: 'uuid' }) declare id: string;
  @ApiProperty({ format: 'uuid' }) declare tenantId: string;
  @ApiProperty({ format: 'uuid' }) declare caseId: string;
  @ApiProperty({ minimum: 1 }) declare versionNumber: number;
  @ApiProperty({ enum: ['generating', 'draft', 'approved', 'rejected', 'failed'] }) declare status: MemoVersion['status'];
  @ApiProperty({ type: 'object', additionalProperties: true, nullable: true }) declare content: CreditMemoContent | null;
  @ApiProperty({ format: 'date-time', nullable: true }) declare approvedAt: string | null;
  @ApiProperty({ format: 'date-time', nullable: true }) declare rejectedAt: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'Decrypted rejection reason; only available to authorized tenant members.' }) declare rejectionReason: string | null;
}

export class MemoVersionsResponseDto {
  @ApiProperty({ type: [MemoVersionResponseDto] }) declare items: readonly MemoVersionResponseDto[];
}
