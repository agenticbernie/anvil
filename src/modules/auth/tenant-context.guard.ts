import { BadRequestException, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { Inject } from '@nestjs/common';
import type { TenantRole } from '../cases/application/case.types.js';
import { TENANT_MEMBERSHIP_REPOSITORY } from './auth.tokens.js';
import type { AuthenticatedUser, TenantContext, TenantMembershipRepository } from './tenant.types.js';

interface TenantRequest extends Request {
  user?: AuthenticatedUser;
  tenantContext?: TenantContext;
}

@Injectable()
export class TenantContextGuard implements CanActivate {
  constructor(@Inject(TENANT_MEMBERSHIP_REPOSITORY) private readonly memberships: TenantMembershipRepository) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<TenantRequest>();
    const actor = request.user;
    if (!actor) throw new UnauthorizedException('Authenticated user is required.');
    const header = request.headers['x-tenant-id'];
    if (Array.isArray(header) && header.length !== 1) throw new BadRequestException('Provide exactly one x-tenant-id header.');
    const selectedHeader = Array.isArray(header) ? header[0] : header;
    const claim = actor.appMetadata.tenant_id;
    if (claim !== undefined && (typeof claim !== 'string' || !isUuid(claim))) {
      throw new ForbiddenException('Signed tenant claim is invalid.');
    }
    if (selectedHeader && claim && selectedHeader.toLowerCase() !== claim.toLowerCase()) {
      throw new ForbiddenException('Tenant selector conflicts with the signed tenant claim.');
    }
    const tenantId = selectedHeader ?? claim;
    if (typeof tenantId !== 'string') throw new BadRequestException('x-tenant-id header or signed tenant claim is required.');
    if (!isUuid(tenantId)) throw new BadRequestException('Tenant selector must be a UUID.');

    const role: TenantRole | null = await this.memberships.findActiveRole(tenantId, actor.id);
    if (!role) throw new ForbiddenException('Active membership in the selected tenant is required.');
    request.tenantContext = { tenantId, actorId: actor.id, role };
    return true;
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
