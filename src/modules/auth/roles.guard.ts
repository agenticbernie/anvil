import { ForbiddenException, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { TenantContext } from './tenant.types.js';
import { TENANT_ROLES_KEY } from './roles.decorator.js';

interface RequestWithTenant { tenantContext?: TenantContext; }

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<readonly string[]>(TENANT_ROLES_KEY, [context.getHandler(), context.getClass()]);
    if (!required || required.length === 0) return true;
    const tenant = context.switchToHttp().getRequest<RequestWithTenant>().tenantContext;
    if (!tenant || !required.includes(tenant.role)) throw new ForbiddenException('Tenant role is not authorized for this operation.');
    return true;
  }
}
