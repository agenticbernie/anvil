import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ApiErrorResponseDto {
  @ApiProperty({ example: 400, description: 'HTTP status code.' })
  statusCode!: number;

  @ApiProperty({ oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }], example: 'Request validation failed.' })
  message!: string | readonly string[];

  @ApiPropertyOptional({ example: 'Bad Request', description: 'NestJS HTTP exception label when present.' })
  error?: string;
}
