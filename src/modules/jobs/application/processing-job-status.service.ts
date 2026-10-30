import { Injectable, NotFoundException } from '@nestjs/common';
import type { UnitOfWork } from '../../../infrastructure/database/tenant-transaction.js';
import type { ProcessingJobRepository } from '../../documents/application/document.types.js';

@Injectable()
export class ProcessingJobStatusService {
  constructor(private readonly jobs: ProcessingJobRepository, private readonly unitOfWork: UnitOfWork) {}

  async get(tenantId: string, actorId: string, jobId: string) {
    const job = await this.unitOfWork.run({ tenantId, actorId }, (transaction) =>
      this.jobs.findById(tenantId, actorId, jobId, transaction));
    if (!job) throw new NotFoundException('Processing job not found in this tenant.');
    return job;
  }
}
