import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ApiCommonErrors } from '../../../common/openapi/api-common-errors.decorator.js';
import { Roles } from '../../auth/roles.decorator.js';
import { RolesGuard } from '../../auth/roles.guard.js';
import { SupabaseAuthGuard } from '../../auth/supabase-auth.guard.js';
import { TenantContextGuard } from '../../auth/tenant-context.guard.js';
import { TenantContextParam, TenantId } from '../../auth/tenant-context.decorator.js';
import type { TenantContext } from '../../auth/tenant.types.js';
import { EntityService } from '../application/entity.service.js';
import { CreateEntityDto, EntityResponseDto } from './entity.dto.js';

@ApiTags('Entities')
@ApiBearerAuth()
@ApiHeader({ name: 'x-tenant-id', required: true, description: 'Tenant selector validated against active membership.', example: '00000000-0000-4000-8000-000000000001' })
@Controller('entities')
@UseGuards(SupabaseAuthGuard, TenantContextGuard, RolesGuard)
export class EntitiesController {
  constructor(private readonly entities: EntityService) {}

  @Post()
  @Roles('tenant_admin', 'originator')
  @ApiOperation({ summary: 'Create a tenant-scoped entity.', description: 'Creates an individual or business entity. The legal name is encrypted before persistence, and tenant scope is derived from the authenticated x-tenant-id context.' })
  @ApiBody({ type: CreateEntityDto, description: 'Entity legal name and type. Tenant ID is never accepted in the request body.', examples: { individual: { summary: 'Create an individual', value: { name: 'Avery Chen', type: 'individual' } }, business: { summary: 'Create a business', value: { name: 'Northstar Components LLC', type: 'business' } } } })
  @ApiResponse({ status: 201, description: 'Entity created. Sensitive legal name is not returned.', type: EntityResponseDto, example: { id: '00000000-0000-4000-8000-000000000031', tenantId: '00000000-0000-4000-8000-000000000001', entityType: 'individual', createdAt: '2026-11-01T00:00:00.000Z' } })
  @ApiCommonErrors({ 400: 'Entity name or type is invalid.', 403: 'Active tenant membership or entity creation role is required.' })
  async create(@TenantId() tenantId: string, @TenantContextParam() context: TenantContext, @Body() body: CreateEntityDto) {
    return this.entities.create(tenantId, context.actorId, context.role, body);
  }
}
