import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { TENANT_MEMBERSHIP_REPOSITORY } from './auth.tokens.js';
import { PostgresTenantMembershipRepository } from './infrastructure/postgres-tenant-membership.repository.js';
import { RolesGuard } from './roles.guard.js';
import { SupabaseAuthGuard } from './supabase-auth.guard.js';
import { SupabaseJwtStrategy } from './supabase-jwt.strategy.js';
import { TenantContextGuard } from './tenant-context.guard.js';

@Module({
  imports: [PassportModule.register({ defaultStrategy: 'jwt' })],
  providers: [
    SupabaseJwtStrategy, SupabaseAuthGuard, TenantContextGuard, RolesGuard, PostgresTenantMembershipRepository,
    { provide: TENANT_MEMBERSHIP_REPOSITORY, useExisting: PostgresTenantMembershipRepository },
  ],
  exports: [SupabaseAuthGuard, TenantContextGuard, RolesGuard, TENANT_MEMBERSHIP_REPOSITORY],
})
export class AuthModule {}
