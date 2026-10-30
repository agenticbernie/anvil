import { Controller, Get, Header, Param, ParseUUIDPipe, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { ApiCommonErrors } from '../../../common/openapi/api-common-errors.decorator.js';
import { Roles } from '../../auth/roles.decorator.js';
import { RolesGuard } from '../../auth/roles.guard.js';
import { SupabaseAuthGuard } from '../../auth/supabase-auth.guard.js';
import { TenantContextGuard } from '../../auth/tenant-context.guard.js';
import { TenantContextParam, TenantId } from '../../auth/tenant-context.decorator.js';
import type { TenantContext } from '../../auth/tenant.types.js';
import { ProcessingJobStatusService } from '../application/processing-job-status.service.js';
import { JobStatusResponseDto } from './job.dto.js';

@ApiTags('Processing Jobs')
@ApiBearerAuth()
@ApiHeader({ name: 'x-tenant-id', required: true, description: 'Tenant selector validated against active membership.', example: '00000000-0000-4000-8000-000000000001' })
@Controller('jobs')
@UseGuards(SupabaseAuthGuard, TenantContextGuard, RolesGuard)
@Roles('tenant_admin', 'originator', 'analyst', 'reviewer', 'auditor')
export class JobsController {
  constructor(private readonly jobs: ProcessingJobStatusService) {}

  @Get(':jobId')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Get the status of an asynchronous processing job.', description: 'Returns only the job visible to the active tenant, including progress and a stable error code. Internal error text and worker details are not exposed.' })
  @ApiParam({ name: 'jobId', format: 'uuid', description: 'Processing job identifier returned when work was accepted.' })
  @ApiOkResponse({ description: 'Current processing job state.', type: JobStatusResponseDto, example: { id: '00000000-0000-4000-8000-000000000061', caseId: '00000000-0000-4000-8000-000000000021', documentId: '00000000-0000-4000-8000-000000000041', status: 'processing', progress: 60, error_code: null, attemptCount: 1, updatedAt: '2026-10-30T00:05:00.000Z' }, headers: { 'Cache-Control': { description: 'Response uses Cache-Control: no-store.', schema: { type: 'string', example: 'no-store' } } } })
  @ApiCommonErrors({ 400: 'Job identifier is not a UUID.', 403: 'Active tenant membership and a read role are required.', 404: 'Job does not exist in the selected tenant.' })
  get(
    @TenantId() tenantId: string,
    @TenantContextParam() context: TenantContext,
    @Param('jobId', new ParseUUIDPipe({ version: '4' })) jobId: string,
  ): Promise<JobStatusResponseDto> {
    return this.jobs.get(tenantId, context.actorId, jobId).then((job) => ({
      id: job.id,
      caseId: job.caseId,
      documentId: job.documentId,
      status: job.status,
      progress: job.progress,
      error_code: job.errorCode,
      attemptCount: job.attemptCount,
      updatedAt: job.updatedAt,
    }));
  }
}
