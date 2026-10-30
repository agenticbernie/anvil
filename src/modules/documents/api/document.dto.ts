import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsInt, IsString, Matches, Max, Min } from 'class-validator';
import { ALLOWED_DOCUMENT_CONTENT_TYPES, type DocumentContentType, type DocumentListItem } from '../application/document.types.js';

export class PresignDocumentDto {
  @ApiProperty({ enum: ALLOWED_DOCUMENT_CONTENT_TYPES, example: 'application/pdf' })
  @IsIn(ALLOWED_DOCUMENT_CONTENT_TYPES)
  contentType!: DocumentContentType;

  @ApiProperty({ minimum: 1, maximum: 52_428_800, example: 1048576, description: 'Plaintext file size. The encrypted R2 object is 16 bytes larger.' })
  @IsInt()
  @Min(1)
  @Max(52_428_800)
  sizeBytes!: number;

  @ApiProperty({ pattern: '^[a-f0-9]{64}$', example: 'a'.repeat(64) })
  @IsString()
  @Matches(/^[a-f0-9]{64}$/i)
  sha256!: string;
}

export class ConfirmUploadDto {
  @ApiProperty({ pattern: '^[a-f0-9]{64}$', example: 'a'.repeat(64) })
  @IsString()
  @Matches(/^[a-f0-9]{64}$/i)
  sha256!: string;
}

export class PresignedDocumentResponseDto {
  @ApiProperty({ format: 'uuid' }) documentId!: string;
  @ApiProperty({ format: 'uri' }) uploadUrl!: string;
  @ApiProperty({ type: Object, additionalProperties: { type: 'string' } }) requiredHeaders!: Readonly<Record<string, string>>;
  @ApiProperty({ format: 'date-time' }) expiresAt!: string;
  @ApiProperty({
    type: Object,
    example: {
      algorithm: 'AES-256-GCM', keyBase64: '<one-time document key>', nonceBase64: '<12-byte nonce>',
      additionalDataBase64: '<authenticated metadata>', tagLengthBits: 128, ciphertextFormat: 'ciphertext+tag',
    },
  })
  encryption!: {
    algorithm: 'AES-256-GCM';
    keyBase64: string;
    nonceBase64: string;
    additionalDataBase64: string;
    tagLengthBits: 128;
    ciphertextFormat: 'ciphertext+tag';
  };
}

export class DocumentAcceptedResponseDto {
  @ApiProperty({ format: 'uuid' }) job_id!: string;
  @ApiProperty({ enum: ['queued', 'processing', 'retry_wait', 'succeeded', 'failed', 'dead_lettered'] })
  status!: 'queued' | 'processing' | 'retry_wait' | 'succeeded' | 'failed' | 'dead_lettered';
}

export class DocumentListItemResponseDto {
  @ApiProperty({ format: 'uuid' }) declare id: string;
  @ApiProperty({ format: 'uuid' }) declare caseId: string;
  @ApiProperty({ enum: ALLOWED_DOCUMENT_CONTENT_TYPES }) declare contentType: DocumentListItem['contentType'];
  @ApiProperty({ minimum: 1 }) declare sizeBytes: number;
  @ApiProperty({ enum: ['pending_upload', 'uploaded', 'processing', 'processed', 'rejected', 'failed'] }) declare status: DocumentListItem['status'];
  @ApiProperty({ format: 'date-time' }) declare createdAt: string;
  @ApiProperty({ format: 'date-time' }) declare updatedAt: string;
}

export class DocumentListResponseDto {
  @ApiProperty({ type: [DocumentListItemResponseDto] }) declare items: readonly DocumentListItemResponseDto[];
}
