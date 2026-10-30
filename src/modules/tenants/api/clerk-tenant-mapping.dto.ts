import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, MaxLength } from 'class-validator';

export class ClerkOrganizationQueryDto {
  @ApiProperty({ description: 'Clerk organization ID selected in the current authenticated session.', example: 'org_2abc123xyz' })
  @IsString()
  @Matches(/^org_[A-Za-z0-9_-]+$/)
  @MaxLength(128)
  org_id!: string;
}

export class TenantMappingResponseDto {
  @ApiProperty({ description: 'Anvil tenant UUID mapped to the Clerk organization.', format: 'uuid', example: '00000000-0000-4000-8000-000000000001' })
  tenant_id!: string;
}
