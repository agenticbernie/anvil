import { IsIn, IsString, MaxLength, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import type { EntityRecord, EntityType } from '../application/entity.types.js';

export class CreateEntityDto {
  @ApiProperty({ minLength: 1, maxLength: 100, description: 'Legal name. Encrypted before persistence.' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @ApiProperty({ enum: ['individual', 'business'] })
  @IsIn(['individual', 'business'])
  type!: EntityType;
}

export class EntityResponseDto implements EntityRecord {
  @ApiProperty({ format: 'uuid' }) declare id: string;
  @ApiProperty({ format: 'uuid' }) declare tenantId: string;
  @ApiProperty({ enum: ['individual', 'business' ] }) declare entityType: EntityType;
  @ApiProperty({ format: 'date-time' }) declare createdAt: string;
}
