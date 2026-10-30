import { Controller, Get, NotImplementedException } from '@nestjs/common';
import { ApiOperation, ApiOkResponse, ApiResponse, ApiTags } from '@nestjs/swagger';

interface HealthResponse {
  status: 'ok' | 'not_configured';
  service: string;
}

@ApiTags('Health')
@Controller('health')
export class HealthController {
  @Get('live')
  @ApiOperation({ summary: 'Check whether the API process is alive.', description: 'Unauthenticated liveness probe for load balancers and process supervisors.' })
  @ApiOkResponse({
    description: 'The API process is running.',
    example: { status: 'ok', service: 'anvil-web' },
    schema: {
      type: 'object',
      required: ['status', 'service'],
      properties: {
        status: { type: 'string', enum: ['ok'] },
        service: { type: 'string', example: 'anvil-web' },
      },
    },
  })
  getLiveness(): HealthResponse {
    return { status: 'ok', service: 'anvil-web' };
  }

  @Get('ready')
  @ApiOperation({ summary: 'Check whether the API can accept requests.', description: 'Unauthenticated readiness probe. Dependency-specific checks are not configured in this phase.' })
  @ApiOkResponse({
    description: 'The API process is ready. External dependency checks are introduced with their adapters.',
    example: { status: 'ok', service: 'anvil-web' },
    schema: {
      type: 'object',
      required: ['status', 'service'],
      properties: {
        status: { type: 'string', enum: ['ok'] },
        service: { type: 'string', example: 'anvil-web' },
      },
    },
  })
  getReadiness(): HealthResponse {
    return { status: 'ok', service: 'anvil-web' };
  }

  @Get('dependencies')
  @ApiOperation({ summary: 'Report dependency health-check availability.', description: 'Reports that detailed dependency probes are not available in this deployment foundation.' })
  @ApiResponse({
    status: 501,
    description: 'Dependency adapters are not configured in the foundation phase.',
    example: { statusCode: 501, message: 'Dependency health checks are not configured yet.', error: 'Not Implemented' },
  })
  getDependencies(): never {
    throw new NotImplementedException('Dependency health checks are not configured yet.');
  }
}
