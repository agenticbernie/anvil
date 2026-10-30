import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards, UseInterceptors } from '@nestjs/common';
import {
  ApiBearerAuth, ApiBody, ApiHeader, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags,
} from '@nestjs/swagger';
import { ApiCommonErrors } from '../../../common/openapi/api-common-errors.decorator.js';
import { Roles } from '../../auth/roles.decorator.js';
import { RolesGuard } from '../../auth/roles.guard.js';
import { SupabaseAuthGuard } from '../../auth/supabase-auth.guard.js';
import { TenantContextGuard } from '../../auth/tenant-context.guard.js';
import { TenantContextParam, TenantId } from '../../auth/tenant-context.decorator.js';
import type { TenantContext } from '../../auth/tenant.types.js';
import { IdempotencyInterceptor } from '../../idempotency/idempotency.interceptor.js';
import { CaseService } from '../application/case.service.js';
import type { TenantRole } from '../application/case.types.js';
import { ArchiveCaseDto, CasePageResponseDto, CreateCaseDto, CreditCaseResponseDto, ListCasesQueryDto, UpdateCaseDto } from './case.dto.js';

@ApiTags('Credit Cases')
@ApiBearerAuth()
@ApiHeader({ name: 'x-tenant-id', required: true, description: 'Tenant selector. The authenticated user must have active membership.', example: '00000000-0000-4000-8000-000000000001' })
@Controller('cases')
@UseGuards(SupabaseAuthGuard, TenantContextGuard, RolesGuard)
export class CasesController {
  constructor(private readonly cases: CaseService) {}

  @Post()
  @UseInterceptors(IdempotencyInterceptor)
  @Roles('tenant_admin', 'originator')
  @ApiOperation({ summary: 'Create a draft credit case.', description: 'Creates a tenant-scoped draft and records an audit event. Replays with the same idempotency key return the original response.' })
  @ApiHeader({ name: 'Idempotency-Key', required: true, description: 'Stable client-generated key for request replay protection.', example: 'phase5-case-create-0001' })
  @ApiBody({ type: CreateCaseDto, description: 'Entity and currency for the new draft case.', examples: { draft: { summary: 'Create a USD credit case', value: { entityId: '00000000-0000-4000-8000-000000000031', currency: 'USD' } } } })
  @ApiResponse({ status: 201, description: 'Draft case created.', type: CreditCaseResponseDto, example: { id: '00000000-0000-4000-8000-000000000041', tenantId: '00000000-0000-4000-8000-000000000001', entityId: '00000000-0000-4000-8000-000000000031', caseNumber: 'ANV-2026-000001', status: 'draft', currency: 'USD', version: 1, createdAt: '2026-10-30T00:00:00.000Z', updatedAt: '2026-10-30T00:00:00.000Z', deletedAt: null } })
  @ApiResponse({ status: 429, description: 'Case creation hourly request budget is exhausted.', example: { statusCode: 429, message: 'Case creation hourly request budget is exhausted.', error: 'Too Many Requests' } })
  @ApiCommonErrors({ 400: 'Invalid request body, currency, or idempotency key.', 409: 'Idempotency key conflicts or the tenant lifetime case limit has been reached.' })
  async create(@TenantId() tenantId: string, @TenantContextParam() context: TenantContext, @Body() body: CreateCaseDto) {
    return this.cases.create(tenantId, context.actorId, context.role, body);
  }

  @Get()
  @Roles('tenant_admin', 'originator', 'analyst', 'reviewer', 'auditor')
  @ApiOperation({ summary: 'List tenant credit cases using cursor pagination.', description: 'Returns only cases visible in the selected tenant. The cursor is opaque and can be reused to fetch the next page.' })
  @ApiQuery({ name: 'limit', required: false, type: Number, minimum: 1, maximum: 100, description: 'Maximum number of cases to return.' })
  @ApiQuery({ name: 'cursor', required: false, type: String, description: 'Opaque cursor from a previous page response.' })
  @ApiResponse({ status: 200, description: 'Tenant case page.', type: CasePageResponseDto, example: { items: [], nextCursor: null } })
  @ApiCommonErrors({ 400: 'Invalid cursor or page size.', 403: 'No active tenant membership.' })
  async list(@TenantId() tenantId: string, @TenantContextParam() context: TenantContext, @Query() query: ListCasesQueryDto) {
    return this.cases.list(tenantId, context.actorId, { limit: query.limit ?? 20, ...(query.cursor ? { cursor: query.cursor } : {}) });
  }

  @Get(':id')
  @Roles('tenant_admin', 'originator', 'analyst', 'reviewer', 'auditor')
  @ApiOperation({ summary: 'Get one credit case by ID.', description: 'Returns a single case only when it belongs to the active tenant.' })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Credit case identifier.' })
  @ApiResponse({ status: 200, description: 'Tenant-scoped credit case.', type: CreditCaseResponseDto, example: { id: '00000000-0000-4000-8000-000000000041', tenantId: '00000000-0000-4000-8000-000000000001', entityId: '00000000-0000-4000-8000-000000000031', caseNumber: 'ANV-2026-000001', status: 'draft', currency: 'USD', version: 1, createdAt: '2026-10-30T00:00:00.000Z', updatedAt: '2026-10-30T00:00:00.000Z', deletedAt: null } })
  @ApiCommonErrors({ 400: 'Invalid case ID.', 403: 'No active tenant membership.', 404: 'Credit case not found in this tenant.' })
  async findOne(@TenantId() tenantId: string, @TenantContextParam() context: TenantContext, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    return this.cases.findOne(tenantId, context.actorId, id);
  }

  @Patch(':id')
  @UseInterceptors(IdempotencyInterceptor)
  @Roles('tenant_admin', 'originator', 'analyst', 'reviewer')
  @ApiOperation({ summary: 'Move a credit case to the next allowed workflow status.', description: 'Applies a valid workflow transition using optimistic version checking and writes an audit event.' })
  @ApiHeader({ name: 'Idempotency-Key', required: true, description: 'Stable client-generated key for request replay protection.', example: 'phase5-case-update-0001' })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Credit case identifier.' })
  @ApiBody({ type: UpdateCaseDto, description: 'Target workflow state and current case version.', examples: { transition: { summary: 'Move case into review', value: { status: 'in_review', version: 1 } } } })
  @ApiResponse({ status: 200, description: 'Case workflow status updated.', type: CreditCaseResponseDto, example: { id: '00000000-0000-4000-8000-000000000041', tenantId: '00000000-0000-4000-8000-000000000001', entityId: '00000000-0000-4000-8000-000000000031', caseNumber: 'ANV-2026-000001', status: 'in_review', currency: 'USD', version: 2, createdAt: '2026-10-30T00:00:00.000Z', updatedAt: '2026-10-30T00:05:00.000Z', deletedAt: null } })
  @ApiCommonErrors({ 400: 'Invalid status transition or request body.', 403: 'Tenant role is insufficient.', 404: 'Credit case not found in this tenant.', 409: 'Case version is stale or idempotency key conflicts.' })
  async update(@TenantId() tenantId: string, @TenantContextParam() context: TenantContext, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @Body() body: UpdateCaseDto) {
    return this.cases.updateStatus(tenantId, context.actorId, context.role as TenantRole, id, body);
  }

  @Post(':id/archive')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(IdempotencyInterceptor)
  @Roles('tenant_admin', 'originator')
  @ApiOperation({ summary: 'Soft-delete a credit case.', description: 'Archives a case with optimistic version checking and records an audit event.' })
  @ApiHeader({ name: 'Idempotency-Key', required: true, description: 'Stable client-generated key for request replay protection.', example: 'phase5-case-archive-0001' })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Credit case identifier.' })
  @ApiBody({ type: ArchiveCaseDto, description: 'Current case version used for optimistic concurrency.', examples: { archive: { summary: 'Archive the current case version', value: { version: 2 } } } })
  @ApiResponse({ status: 200, description: 'Case archived.', type: CreditCaseResponseDto, example: { id: '00000000-0000-4000-8000-000000000041', tenantId: '00000000-0000-4000-8000-000000000001', entityId: '00000000-0000-4000-8000-000000000031', caseNumber: 'ANV-2026-000001', status: 'in_review', currency: 'USD', version: 3, createdAt: '2026-10-30T00:00:00.000Z', updatedAt: '2026-10-30T00:10:00.000Z', deletedAt: '2026-10-30T00:10:00.000Z' } })
  @ApiCommonErrors({ 400: 'Invalid request body or case ID.', 403: 'Tenant role is insufficient.', 404: 'Credit case not found in this tenant.', 409: 'Case version is stale or idempotency key conflicts.' })
  async archive(@TenantId() tenantId: string, @TenantContextParam() context: TenantContext, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @Body() body: ArchiveCaseDto) {
    return this.cases.archive(tenantId, context.actorId, context.role, id, body.version);
  }
}
