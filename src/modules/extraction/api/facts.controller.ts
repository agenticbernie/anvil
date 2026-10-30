import { Body, Controller, Get, Header, Param, ParseUUIDPipe, Patch, Query, UseGuards, UseInterceptors } from '@nestjs/common';
import {
  ApiBearerAuth, ApiBody, ApiHeader, ApiOkResponse, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags,
} from '@nestjs/swagger';
import { ApiCommonErrors } from '../../../common/openapi/api-common-errors.decorator.js';
import { Roles } from '../../auth/roles.decorator.js';
import { RolesGuard } from '../../auth/roles.guard.js';
import { SupabaseAuthGuard } from '../../auth/supabase-auth.guard.js';
import { TenantContextGuard } from '../../auth/tenant-context.guard.js';
import { TenantContextParam, TenantId } from '../../auth/tenant-context.decorator.js';
import { IdempotencyInterceptor } from '../../idempotency/idempotency.interceptor.js';
import type { TenantContext } from '../../auth/tenant.types.js';
import { ExtractionService } from '../application/extraction.service.js';
import type { ExtractedFact } from '../application/extraction.types.js';
import { ExtractedFactResponseDto, ListFactsQueryDto, UpdateFactDto } from './facts.dto.js';

@ApiTags('Fact Review')
@ApiBearerAuth()
@ApiHeader({ name: 'x-tenant-id', required: true, description: 'Tenant selector validated against active membership.', example: '00000000-0000-4000-8000-000000000001' })
@Controller()
@UseGuards(SupabaseAuthGuard, TenantContextGuard, RolesGuard)
export class FactsController {
  constructor(private readonly extraction: ExtractionService) {}

  @Get('cases/:caseId/facts')
  @Header('Cache-Control', 'no-store')
  @Roles('tenant_admin', 'originator', 'analyst', 'reviewer', 'auditor')
  @ApiOperation({ summary: 'List extracted facts for a credit case.', description: 'Returns tenant-scoped facts with extraction provenance. The optional review_status filter narrows the result without changing stored facts.' })
  @ApiParam({ name: 'caseId', format: 'uuid', description: 'Credit case whose facts should be listed.' })
  @ApiQuery({ name: 'review_status', required: false, enum: ['unverified', 'verified', 'needs_evidence', 'conflict', 'rejected'], description: 'Optional review status filter.' })
  @ApiOkResponse({ description: 'Tenant-scoped extracted fact list.', type: ExtractedFactResponseDto, isArray: true, example: [{ id: '00000000-0000-4000-8000-000000000071', extractionRunId: '00000000-0000-4000-8000-000000000051', caseId: '00000000-0000-4000-8000-000000000021', fieldName: 'annual_revenue', rawValue: 'USD 50,000', normalizedValue: { amount: 50000, currency: 'USD' }, sourcePage: 2, confidence: 0.95, reviewStatus: 'unverified' }], headers: { 'Cache-Control': { description: 'Response uses Cache-Control: no-store for decrypted fact values.', schema: { type: 'string', example: 'no-store' } } } })
  @ApiCommonErrors({ 400: 'Case identifier or review_status is invalid.', 403: 'Active tenant membership and a read role are required.', 404: 'Case does not exist in the selected tenant.' })
  async listForCase(
    @TenantId() tenantId: string,
    @TenantContextParam() context: TenantContext,
    @Param('caseId', new ParseUUIDPipe({ version: '4' })) caseId: string,
    @Query() query: ListFactsQueryDto,
  ): Promise<readonly ExtractedFactResponseDto[]> {
    const facts = await this.extraction.listFactsForCase(tenantId, context.actorId, caseId, query.review_status);
    return facts.map(toFactResponse);
  }

  @Patch('facts/:factId')
  @Header('Cache-Control', 'no-store')
  @UseInterceptors(IdempotencyInterceptor)
  @Roles('tenant_admin', 'analyst', 'reviewer')
  @ApiOperation({ summary: 'Correct or verify an extracted fact while preserving its source provenance.', description: 'Updates the analyst-reviewed value or review status, encrypts sensitive values before persistence, and writes a before/after audit event.' })
  @ApiHeader({ name: 'Idempotency-Key', required: true, description: 'Stable key for safely retrying the same fact update.', example: 'phase5-fact-update-0001' })
  @ApiParam({ name: 'factId', format: 'uuid', description: 'Extracted fact identifier.' })
  @ApiBody({ type: UpdateFactDto, description: 'Optional normalized value, review status, and criticality flag.', examples: { verification: { summary: 'Verify a critical revenue fact', value: { normalizedValue: { amount: 50000, currency: 'USD' }, reviewStatus: 'verified', is_critical: true } } } })
  @ApiResponse({ status: 200, description: 'Fact updated with source provenance retained.', type: ExtractedFactResponseDto, example: { id: '00000000-0000-4000-8000-000000000071', extractionRunId: '00000000-0000-4000-8000-000000000051', caseId: '00000000-0000-4000-8000-000000000021', fieldName: 'annual_revenue', rawValue: 'USD 50,000', normalizedValue: { amount: 50000, currency: 'USD' }, sourcePage: 2, confidence: 0.95, reviewStatus: 'verified', is_critical: true }, headers: { 'Cache-Control': { description: 'Response uses Cache-Control: no-store for decrypted fact data.', schema: { type: 'string', example: 'no-store' } } } })
  @ApiResponse({ status: 429, description: 'Fact review update hourly budget is exhausted.', example: { statusCode: 429, message: 'Fact review update hourly budget is exhausted.', error: 'Too Many Requests' } })
  @ApiCommonErrors({ 400: 'Invalid JSON fact value or empty patch.', 403: 'Tenant membership or review role is insufficient.', 404: 'Fact does not exist in the selected tenant.', 409: 'Idempotency collision, concurrent state conflict, or tenant lifetime fact review update cap reached.' })
  async update(
    @TenantId() tenantId: string,
    @TenantContextParam() context: TenantContext,
    @Param('factId', new ParseUUIDPipe({ version: '4' })) factId: string,
    @Body() body: UpdateFactDto,
  ) {
    const fact = await this.extraction.updateFact(tenantId, context.actorId, factId, {
      ...(body.normalizedValue !== undefined ? { normalizedValue: body.normalizedValue } : {}),
      ...(body.reviewStatus !== undefined ? { reviewStatus: body.reviewStatus } : {}),
      ...(body.is_critical !== undefined ? { isCritical: body.is_critical } : {}),
    });
    return toFactResponse(fact);
  }
}

function toFactResponse(fact: ExtractedFact): ExtractedFactResponseDto {
  return {
    id: fact.id,
    tenantId: fact.tenantId,
    extractionRunId: fact.extractionRunId,
    caseId: fact.caseId,
    fieldName: fact.fieldName,
    rawValue: fact.rawValue,
    normalizedValue: fact.normalizedValue,
    sourcePage: fact.sourcePage,
    confidence: fact.confidence,
    reviewStatus: fact.reviewStatus,
    isCritical: fact.isCritical,
    is_critical: fact.isCritical,
  };
}
