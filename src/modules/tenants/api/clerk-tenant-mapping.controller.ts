import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { ApiCommonErrors } from '../../../common/openapi/api-common-errors.decorator.js';
import { SupabaseAuthGuard } from '../../auth/supabase-auth.guard.js';
import type { AuthenticatedUser } from '../../auth/tenant.types.js';
import { ClerkOrganizationQueryDto, TenantMappingResponseDto } from './clerk-tenant-mapping.dto.js';
import { TenantMappingService } from '../services/tenant-mapping.service.js';

interface AuthenticatedRequest extends Request { user?: AuthenticatedUser; }

@ApiTags('Tenants')
@ApiBearerAuth()
@Controller('tenants')
@UseGuards(SupabaseAuthGuard)
export class ClerkTenantMappingController {
  constructor(private readonly tenantMapping: TenantMappingService) {}

  @Get('by-clerk-org')
  @ApiOperation({ summary: 'Resolve the active Anvil tenant for a Clerk organization.', description: 'Requires a Supabase bearer token whose Clerk identity has an active membership in the requested organization. Unprovisioned or inaccessible organizations return 404.' })
  @ApiQuery({ name: 'org_id', required: true, type: String, description: 'Clerk organization ID in org_* format.', example: 'org_2abc123xyz' })
  @ApiOkResponse({ description: 'Tenant UUID mapped to the authenticated Clerk organization.', type: TenantMappingResponseDto, example: { tenant_id: '00000000-0000-4000-8000-000000000001' } })
  @ApiCommonErrors({ 400: 'org_id is missing or invalid.', 401: 'Supabase bearer token is missing or invalid.', 404: 'Organization tenant is not provisioned or the caller is not an active member.' })
  getByClerkOrganization(
    @Query() query: ClerkOrganizationQueryDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<TenantMappingResponseDto> {
    return this.tenantMapping.findByClerkOrganization(query.org_id, request.user!.id);
  }
}
