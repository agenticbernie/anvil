import { Body, Controller, Get, Header, HttpCode, HttpStatus, Inject, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiAcceptedResponse, ApiBearerAuth, ApiBody, ApiCreatedResponse, ApiHeader, ApiOkResponse, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ApiCommonErrors } from '../../../common/openapi/api-common-errors.decorator.js';
import type { TenantContext } from '../../auth/tenant.types.js';
import { Roles } from '../../auth/roles.decorator.js';
import { RolesGuard } from '../../auth/roles.guard.js';
import { SupabaseAuthGuard } from '../../auth/supabase-auth.guard.js';
import { TenantContextGuard } from '../../auth/tenant-context.guard.js';
import { TenantContextParam, TenantId } from '../../auth/tenant-context.decorator.js';
import { DocumentService } from '../application/document.service.js';
import { ConfirmUploadDto, DocumentAcceptedResponseDto, DocumentListResponseDto, PresignDocumentDto, PresignedDocumentResponseDto } from './document.dto.js';

@ApiTags('documents')
@ApiBearerAuth()
@ApiHeader({ name: 'x-tenant-id', required: true, description: 'Tenant selector validated against active membership.', example: '00000000-0000-4000-8000-000000000001' })
@Controller('cases/:caseId/documents')
@UseGuards(SupabaseAuthGuard, TenantContextGuard, RolesGuard)
@Roles('tenant_admin', 'originator')
export class CaseDocumentsController {
  constructor(@Inject(DocumentService) private readonly documents: DocumentService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @Roles('tenant_admin', 'originator', 'analyst', 'reviewer', 'auditor')
  @ApiOperation({ summary: 'List documents belonging to a credit case.', description: 'Returns safe document metadata for the selected tenant and case. Storage keys, hashes, encryption material, and upload credentials are never included.' })
  @ApiParam({ name: 'caseId', format: 'uuid', description: 'Credit case whose documents should be listed.' })
  @ApiOkResponse({ description: 'Tenant-scoped document list.', type: DocumentListResponseDto, example: { items: [{ id: '00000000-0000-4000-8000-000000000041', caseId: '00000000-0000-4000-8000-000000000021', contentType: 'application/pdf', sizeBytes: 1048576, status: 'processed', createdAt: '2026-10-30T00:00:00.000Z', updatedAt: '2026-10-30T00:05:00.000Z' }] }, headers: { 'Cache-Control': { description: 'Response uses Cache-Control: no-store.', schema: { type: 'string', example: 'no-store' } } } })
  @ApiCommonErrors({ 400: 'Case identifier is not a UUID.', 403: 'Active tenant membership and a read role are required.', 404: 'Case does not exist in the selected tenant.' })
  async listForCase(
    @TenantId() tenantId: string,
    @TenantContextParam() tenant: TenantContext,
    @Param('caseId', new ParseUUIDPipe({ version: '4' })) caseId: string,
  ): Promise<DocumentListResponseDto> {
    return { items: await this.documents.listForCase(tenantId, tenant.actorId, caseId) };
  }

  @Post('presign')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Create a short lived direct upload URL for a case document.', description: 'Reserves a tenant-scoped encrypted upload and returns the one-time data key to the authenticated uploader. The key is never logged or stored in plaintext.' })
  @ApiParam({ name: 'caseId', format: 'uuid', description: 'Credit case that will own the uploaded document.' })
  @ApiBody({ type: PresignDocumentDto, description: 'File metadata used to reserve the encrypted upload.', examples: { pdf: { summary: 'Reserve a PDF upload', value: { contentType: 'application/pdf', sizeBytes: 1048576, sha256: 'a'.repeat(64) } } } })
  @ApiCreatedResponse({ description: 'Upload reservation and direct upload URL created. The one-time encryption key response must not be cached.', type: PresignedDocumentResponseDto, headers: { 'Cache-Control': { description: 'The no-store policy prevents caches from retaining the one-time encryption key and signed upload URL.', schema: { type: 'string', example: 'no-store' } } }, example: { documentId: '00000000-0000-4000-8000-000000000041', uploadUrl: 'https://example.invalid/signed-upload', requiredHeaders: { 'content-length': '1048592', 'content-type': 'application/pdf', 'x-amz-meta-sha256': 'a'.repeat(64) }, expiresAt: '2026-10-30T00:15:00.000Z', encryption: { algorithm: 'AES-256-GCM', keyBase64: '<one-time-key-returned-to-uploader>', nonceBase64: '<12-byte-nonce>', additionalDataBase64: '<authenticated-metadata>', tagLengthBits: 128, ciphertextFormat: 'ciphertext+tag' } } })
  @ApiResponse({ status: 429, description: 'The active reservation or hourly upload budget is exhausted.', example: { statusCode: 429, message: 'Document upload reservation rate limit exceeded.', error: 'Too Many Requests' } })
  @ApiCommonErrors({ 400: 'Invalid file type, declared size, digest, or case ID.', 403: 'Active tenant membership and upload role are required.', 404: 'Case not found in the active tenant.', 409: 'The tenant lifetime limit of 1,000 document reservations or 10 GiB of declared ciphertext has been reached.' })
  async presign(
    @Param('caseId', new ParseUUIDPipe({ version: '4' })) caseId: string,
    @TenantContextParam() tenant: TenantContext,
    @Body() input: PresignDocumentDto,
  ): Promise<PresignedDocumentResponseDto> {
    const result = await this.documents.presignUpload(tenant.tenantId, tenant.actorId, { ...input, caseId });
    return {
      documentId: result.documentId,
      uploadUrl: result.uploadUrl,
      requiredHeaders: result.requiredHeaders,
      expiresAt: result.expiresAt,
      encryption: result.encryption,
    };
  }
}

@ApiTags('documents')
@ApiBearerAuth()
@ApiHeader({ name: 'x-tenant-id', required: true, description: 'Tenant selector validated against active membership.', example: '00000000-0000-4000-8000-000000000001' })
@Controller('documents')
@UseGuards(SupabaseAuthGuard, TenantContextGuard, RolesGuard)
@Roles('tenant_admin', 'originator')
export class DocumentsController {
  constructor(@Inject(DocumentService) private readonly documents: DocumentService) {}

  @Post(':documentId/confirm-upload')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Confirm an uploaded document and enqueue asynchronous parsing.', description: 'Verifies the uploaded object digest and commits processing work with its outbox event. Parsing runs asynchronously after this endpoint returns.' })
  @ApiParam({ name: 'documentId', format: 'uuid', description: 'Document reservation identifier.' })
  @ApiBody({ type: ConfirmUploadDto, description: 'Digest declared for the uploaded object.', examples: { confirm: { summary: 'Confirm the uploaded object digest', value: { sha256: 'a'.repeat(64) } } } })
  @ApiAcceptedResponse({ type: DocumentAcceptedResponseDto, description: 'Accepted; parsing runs asynchronously.', example: { job_id: '00000000-0000-4000-8000-000000000061', status: 'queued' } })
  @ApiCommonErrors({ 400: 'Invalid digest or document identifier.', 403: 'Active tenant membership and upload role are required.', 404: 'Document not found in the active tenant.', 409: 'The object digest or upload state conflicts with the reservation.' })
  async confirmUpload(
    @Param('documentId', new ParseUUIDPipe({ version: '4' })) documentId: string,
    @TenantContextParam() tenant: TenantContext,
    @Body() input: ConfirmUploadDto,
  ): Promise<DocumentAcceptedResponseDto> {
    const result = await this.documents.confirmUpload(tenant.tenantId, tenant.actorId, documentId, input);
    return { job_id: result.jobId, status: result.status };
  }
}
