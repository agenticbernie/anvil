import { Controller, Get, InternalServerErrorException, Logger, NotFoundException, Query, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
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
  private readonly logger = new Logger(ClerkTenantMappingController.name);

  constructor(private readonly tenantMapping: TenantMappingService) {}

  @Get('by-clerk-org')
  @ApiOperation({ summary: 'Resolve the active Anvil tenant for a Clerk organization.', description: 'Requires a Supabase bearer token whose Clerk identity has an active membership in the requested organization. Unprovisioned or inaccessible organizations return 404.' })
  @ApiQuery({ name: 'org_id', required: true, type: String, description: 'Clerk organization ID in org_* format.', example: 'org_2abc123xyz' })
  @ApiOkResponse({ description: 'Tenant UUID mapped to the authenticated Clerk organization.', type: TenantMappingResponseDto, example: { tenant_id: '00000000-0000-4000-8000-000000000001' } })
  @ApiCommonErrors({ 400: 'org_id is missing or invalid.', 401: 'Supabase bearer token is missing or invalid.', 404: 'Organization tenant is not provisioned or the caller is not an active member.' })
  async getByClerkOrganization(
    @Query() query: ClerkOrganizationQueryDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<TenantMappingResponseDto> {
    const actorId = request.user?.id;
    if (!actorId) throw new UnauthorizedException('Authenticated user is required for tenant mapping.');
    this.logger.log(`Mapping request received: org_id=${query.org_id}, user_id=${actorId}`);
    try {
      const result = await this.tenantMapping.findByClerkOrganization(query.org_id, actorId);
      this.logger.log(`Tenant mapping resolved: org_id=${query.org_id}, tenant_id=${result.tenant_id}, user_id=${actorId}`);
      return result;
    } catch (error) {
      if (error instanceof NotFoundException) {
        this.logger.warn(`Tenant not found for org_id=${query.org_id}, user_id=${actorId}`);
        throw error;
      }
      const details = error instanceof Error ? error.stack : undefined;
      this.logger.error(`Tenant mapping database lookup failed: org_id=${query.org_id}, user_id=${actorId}`, details);
      throw new InternalServerErrorException('Tenant mapping lookup failed. Please try again.');
    }
  }
}
