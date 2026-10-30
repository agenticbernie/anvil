import { Body, Controller, Get, Header, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import {
  ApiAcceptedResponse, ApiBearerAuth, ApiBody, ApiHeader, ApiOkResponse, ApiOperation, ApiParam, ApiResponse, ApiTags,
} from '@nestjs/swagger';
import { ApiCommonErrors } from '../../../common/openapi/api-common-errors.decorator.js';
import { Roles } from '../../auth/roles.decorator.js';
import { RolesGuard } from '../../auth/roles.guard.js';
import { SupabaseAuthGuard } from '../../auth/supabase-auth.guard.js';
import { TenantContextGuard } from '../../auth/tenant-context.guard.js';
import { TenantContextParam, TenantId } from '../../auth/tenant-context.decorator.js';
import { IdempotencyInterceptor } from '../../idempotency/idempotency.interceptor.js';
import type { TenantContext } from '../../auth/tenant.types.js';
import { ApproveMemoDto, MemoAcceptedResponseDto, MemoVersionResponseDto, MemoVersionsResponseDto, RejectMemoDto, RequestMemoGenerationDto } from './memo.dto.js';
import { MemoService } from '../application/memo.service.js';

@ApiTags('Credit Memos')
@ApiBearerAuth()
@ApiHeader({ name: 'x-tenant-id', required: true, description: 'Tenant selector validated against active membership.', example: '00000000-0000-4000-8000-000000000001' })
@Controller()
@UseGuards(SupabaseAuthGuard, TenantContextGuard, RolesGuard)
export class MemosController {
  constructor(private readonly memos: MemoService) {}

  @Post('cases/:caseId/memos/generate')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseInterceptors(IdempotencyInterceptor)
  @Roles('tenant_admin', 'analyst')
  @ApiOperation({ summary: 'Queue generation of a draft credit memo.', description: 'Persists an outbox request and returns immediately; memo generation runs asynchronously.' })
  @ApiHeader({ name: 'Idempotency-Key', required: true, description: 'Stable key for safely retrying the generation request.', example: 'phase5-memo-generate-0001' })
  @ApiParam({ name: 'caseId', format: 'uuid', description: 'Credit case used as the memo evidence scope.' })
  @ApiBody({ type: RequestMemoGenerationDto, required: false, description: 'A reason is required only when unresolved critical facts are in conflict.', examples: { noConflicts: { summary: 'Queue generation without conflicts', value: {} }, criticalConflict: { summary: 'Document the critical conflict override', value: { override_reason: 'Conflicting financial evidence was reviewed for this draft.' } } } })
  @ApiAcceptedResponse({ description: 'Memo generation accepted.', type: MemoAcceptedResponseDto, example: { accepted: true, jobId: '00000000-0000-4000-8000-000000000061' } })
  @ApiResponse({ status: 429, description: 'Memo generation hourly request budget is exhausted for this actor or tenant.', example: { statusCode: 429, message: 'Memo generation request rate limit exceeded.', error: 'Too Many Requests' } })
  @ApiCommonErrors({ 400: 'Invalid case ID.', 403: 'Tenant membership or analyst role is insufficient.', 404: 'Credit case not found in this tenant.', 409: 'The tenant lifetime limit of 100,000 memo generation requests has been reached.' })
  requestGeneration(@TenantId() tenantId: string, @TenantContextParam() context: TenantContext, @Param('caseId', new ParseUUIDPipe({ version: '4' })) caseId: string, @Body() body?: RequestMemoGenerationDto) {
    return this.memos.requestGeneration(tenantId, context.actorId, caseId, body?.override_reason);
  }

  @Get('cases/:caseId/memos')
  @Header('Cache-Control', 'no-store')
  @Roles('tenant_admin', 'originator', 'analyst', 'reviewer', 'auditor')
  @ApiOperation({ summary: 'List memo versions for a credit case.', description: 'Returns tenant-scoped memo versions, newest first. Structured memo content is decrypted only after tenant authorization and the response is not cacheable.' })
  @ApiParam({ name: 'caseId', format: 'uuid', description: 'Credit case whose memo versions should be listed.' })
  @ApiOkResponse({ description: 'Tenant-scoped memo versions, newest first.', type: MemoVersionsResponseDto, example: { items: [{ id: '00000000-0000-4000-8000-000000000081', tenantId: '00000000-0000-4000-8000-000000000001', caseId: '00000000-0000-4000-8000-000000000021', versionNumber: 1, status: 'approved', content: { borrower_overview: 'Evidence-based summary.', request_summary: 'Review requested.', financial_highlights: [], risks: [], mitigants: [], recommendation: 'undetermined' }, approvedAt: '2026-10-30T00:10:00.000Z', rejectedAt: null, rejectionReason: null }] }, headers: { 'Cache-Control': { description: 'Response uses Cache-Control: no-store for decrypted memo content.', schema: { type: 'string', example: 'no-store' } } } })
  @ApiCommonErrors({ 400: 'Case identifier is not a UUID.', 403: 'Active tenant membership and a read role are required.', 404: 'Case does not exist in the selected tenant.' })
  async listForCase(
    @TenantId() tenantId: string,
    @TenantContextParam() context: TenantContext,
    @Param('caseId', new ParseUUIDPipe({ version: '4' })) caseId: string,
  ): Promise<MemoVersionsResponseDto> {
    return { items: await this.memos.listForCase(tenantId, context.actorId, caseId) };
  }

  @Get('memos/:memoId')
  @Header('Cache-Control', 'no-store')
  @Roles('tenant_admin', 'originator', 'analyst', 'reviewer', 'auditor')
  @ApiOperation({ summary: 'Retrieve a memo draft and its decrypted structured content.', description: 'Returns a memo version visible to the active tenant. PII fields are decrypted only after authorization.' })
  @ApiParam({ name: 'memoId', format: 'uuid', description: 'Memo version identifier.' })
  @ApiResponse({ status: 200, description: 'Tenant-scoped memo version.', type: MemoVersionResponseDto, example: { id: '00000000-0000-4000-8000-000000000081', tenantId: '00000000-0000-4000-8000-000000000001', caseId: '00000000-0000-4000-8000-000000000021', versionNumber: 1, status: 'draft', content: { borrower_overview: 'Evidence-based summary.', request_summary: 'Review requested.', financial_highlights: [], risks: [], mitigants: [], recommendation: 'undetermined' }, approvedAt: null, rejectedAt: null, rejectionReason: null }, headers: { 'Cache-Control': { description: 'Response uses Cache-Control: no-store for decrypted memo content.', schema: { type: 'string', example: 'no-store' } } } })
  @ApiCommonErrors({ 403: 'Tenant membership is required.', 404: 'Memo not found in this tenant.' })
  get(@TenantId() tenantId: string, @TenantContextParam() context: TenantContext, @Param('memoId', new ParseUUIDPipe({ version: '4' })) memoId: string) {
    return this.memos.get(tenantId, context.actorId, memoId);
  }

  @Post('memos/:memoId/approve')
  @Header('Cache-Control', 'no-store')
  @HttpCode(HttpStatus.OK)
  @Roles('tenant_admin', 'reviewer')
  @ApiOperation({ summary: 'Approve a draft memo; critical conflicts require an override reason.', description: 'Approves the draft only when no unresolved critical conflict exists or a bounded override reason is supplied. Approval is serialized with critical fact review.' })
  @ApiParam({ name: 'memoId', format: 'uuid', description: 'Draft memo version identifier.' })
  @ApiBody({ type: ApproveMemoDto, description: 'Supply an override reason only after reviewing unresolved critical conflicts.', examples: { noOverride: { summary: 'Approve without conflicts', value: {} }, override: { summary: 'Approve after documenting conflict review', value: { override_reason: 'Conflicting financial evidence was reviewed.' } } } })
  @ApiResponse({ status: 200, description: 'Memo approved and approval audit event recorded.', type: MemoVersionResponseDto, example: { id: '00000000-0000-4000-8000-000000000081', tenantId: '00000000-0000-4000-8000-000000000001', caseId: '00000000-0000-4000-8000-000000000021', versionNumber: 1, status: 'approved', content: { borrower_overview: 'Evidence-based summary.', request_summary: 'Review requested.', financial_highlights: [], risks: [], mitigants: [], recommendation: 'undetermined' }, approvedAt: '2026-10-30T00:10:00.000Z', rejectedAt: null, rejectionReason: null }, headers: { 'Cache-Control': { description: 'Response uses Cache-Control: no-store for decrypted memo content.', schema: { type: 'string', example: 'no-store' } } } })
  @ApiCommonErrors({ 400: 'Invalid override_reason.', 403: 'Reviewer role is required.', 404: 'Memo not found in this tenant.', 409: 'Memo is not draft or unresolved critical conflicts require override_reason.' })
  approve(@TenantId() tenantId: string, @TenantContextParam() context: TenantContext, @Param('memoId', new ParseUUIDPipe({ version: '4' })) memoId: string, @Body() body: ApproveMemoDto) {
    return this.memos.approve(tenantId, context.actorId, memoId, body.override_reason);
  }

  @Post('memos/:memoId/reject')
  @Header('Cache-Control', 'no-store')
  @HttpCode(HttpStatus.OK)
  @Roles('tenant_admin', 'reviewer')
  @ApiOperation({ summary: 'Reject a draft memo with a documented reason.', description: 'Changes only a draft memo to rejected, stores the reason encrypted, and writes a memo.rejected audit event containing a keyed reason hash.' })
  @ApiParam({ name: 'memoId', format: 'uuid', description: 'Draft memo version identifier.' })
  @ApiBody({ type: RejectMemoDto, description: 'Required rejection reason, stored encrypted.', examples: { reject: { summary: 'Reject a draft pending additional evidence', value: { reason: 'Updated cash flow evidence is required before this memo can proceed.' } } } })
  @ApiOkResponse({ description: 'Memo rejected and audit event recorded.', type: MemoVersionResponseDto, example: { id: '00000000-0000-4000-8000-000000000081', tenantId: '00000000-0000-4000-8000-000000000001', caseId: '00000000-0000-4000-8000-000000000021', versionNumber: 1, status: 'rejected', content: { borrower_overview: 'Evidence-based summary.', request_summary: 'Review requested.', financial_highlights: [], risks: [], mitigants: [], recommendation: 'undetermined' }, approvedAt: null, rejectedAt: '2026-10-30T00:10:00.000Z', rejectionReason: 'Updated cash flow evidence is required before this memo can proceed.' }, headers: { 'Cache-Control': { description: 'Response uses Cache-Control: no-store for the decrypted rejection reason.', schema: { type: 'string', example: 'no-store' } } } })
  @ApiCommonErrors({ 400: 'Rejection reason is missing, blank, or too long.', 403: 'Tenant membership or reviewer role is insufficient.', 404: 'Memo does not exist in the selected tenant.', 409: 'Only a draft memo can be rejected.' })
  reject(
    @TenantId() tenantId: string,
    @TenantContextParam() context: TenantContext,
    @Param('memoId', new ParseUUIDPipe({ version: '4' })) memoId: string,
    @Body() body: RejectMemoDto,
  ) {
    return this.memos.reject(tenantId, context.actorId, memoId, body.reason);
  }
}
