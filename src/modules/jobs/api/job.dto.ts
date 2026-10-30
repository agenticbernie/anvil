import { ApiProperty } from '@nestjs/swagger';
import type { ProcessingJobStatusRecord } from '../../documents/application/document.types.js';

export class JobStatusResponseDto {
  @ApiProperty({ format: 'uuid' }) declare id: string;
  @ApiProperty({ format: 'uuid' }) declare caseId: string;
  @ApiProperty({ format: 'uuid' }) declare documentId: string;
  @ApiProperty({ enum: ['queued', 'processing', 'retry_wait', 'succeeded', 'failed', 'dead_lettered'] }) declare status: ProcessingJobStatusRecord['status'];
  @ApiProperty({ minimum: 0, maximum: 100 }) declare progress: number;
  @ApiProperty({ type: String, nullable: true, enum: ['DOCUMENT_CHECKSUM_MISMATCH', 'DOCUMENT_ENCRYPTION_FAILED', 'DOCUMENT_PARSE_FAILED'] }) declare error_code: ProcessingJobStatusRecord['errorCode'];
  @ApiProperty({ minimum: 0, maximum: 3 }) declare attemptCount: number;
  @ApiProperty({ format: 'date-time' }) declare updatedAt: string;
}
