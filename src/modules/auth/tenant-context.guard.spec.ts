import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { describe, expect, it, jest } from '@jest/globals';
import { TenantContextGuard } from './tenant-context.guard.js';
import type { TenantMembershipRepository } from './tenant.types.js';

const userId = '00000000-0000-4000-8000-000000000001';
const tenantId = '00000000-0000-4000-8000-000000000002';

function context(headers: Record<string, string>, user = { id: userId, appMetadata: {} }) {
  const request: Record<string, any> = { headers, user };
  return { request, getHandler: () => ({}), getClass: () => ({}), switchToHttp: () => ({ getRequest: () => request }) } as any;
}

describe('TenantContextGuard', () => {
  it('requires a tenant selector when the signed claim is absent', async () => {
    const repository: TenantMembershipRepository = { findActiveRole: jest.fn() };
    await expect(new TenantContextGuard(repository).canActivate(context({}))).rejects.toBeInstanceOf(BadRequestException);
  });

  it('sets tenant context only after active membership lookup succeeds', async () => {
    const repository: TenantMembershipRepository = { findActiveRole: jest.fn().mockResolvedValue('originator') };
    const execution = context({ 'x-tenant-id': tenantId });
    await expect(new TenantContextGuard(repository).canActivate(execution)).resolves.toBe(true);
    expect(repository.findActiveRole).toHaveBeenCalledWith(tenantId, userId);
    expect(execution.request.tenantContext).toEqual({ tenantId, actorId: userId, role: 'originator' });
  });

  it('rejects a tenant selector without active membership', async () => {
    const repository: TenantMembershipRepository = { findActiveRole: jest.fn().mockResolvedValue(null) };
    await expect(new TenantContextGuard(repository).canActivate(context({ 'x-tenant-id': tenantId }))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects a client selector that conflicts with the signed tenant claim', async () => {
    const repository: TenantMembershipRepository = { findActiveRole: jest.fn() };
    const execution = context({ 'x-tenant-id': tenantId }, { id: userId, appMetadata: { tenant_id: '00000000-0000-4000-8000-000000000009' } });
    await expect(new TenantContextGuard(repository).canActivate(execution)).rejects.toBeInstanceOf(ForbiddenException);
    expect(repository.findActiveRole).not.toHaveBeenCalled();
  });
});
