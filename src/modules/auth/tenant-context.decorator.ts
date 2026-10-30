import { createParamDecorator, UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { TenantContext } from './tenant.types.js';

interface TenantRequest extends Request { tenantContext?: TenantContext; }

export const TenantContextParam = createParamDecorator((_data: unknown, context: ExecutionContext): TenantContext => {
  const tenantContext = context.switchToHttp().getRequest<TenantRequest>().tenantContext;
  if (!tenantContext) throw new UnauthorizedException('Tenant context is missing.');
  return tenantContext;
});

export const TenantId = createParamDecorator((_data: unknown, context: ExecutionContext): string => {
  const tenantContext = context.switchToHttp().getRequest<TenantRequest>().tenantContext;
  if (!tenantContext) throw new UnauthorizedException('Tenant context is missing.');
  return tenantContext.tenantId;
});
