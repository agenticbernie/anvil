import { SetMetadata } from '@nestjs/common';
import type { TenantRole } from '../cases/application/case.types.js';

export const TENANT_ROLES_KEY = 'anvil.tenant_roles';
export const Roles = (...roles: TenantRole[]) => SetMetadata(TENANT_ROLES_KEY, roles);
