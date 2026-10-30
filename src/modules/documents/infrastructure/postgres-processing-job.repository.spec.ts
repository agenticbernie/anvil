import { describe, expect, it, jest } from '@jest/globals';
import type { TenantTransaction } from '../../../infrastructure/database/tenant-transaction.js';
import { PostgresProcessingJobRepository } from './postgres-processing-job.repository.js';

describe('PostgresProcessingJobRepository safe errors', () => {
  it('maps persisted worker errors to fixed messages and clears them after success', async () => {
    const query = jest.fn(async () => ({ rowCount: 1 }));
    const transaction = {
      withBackendRole: async (work: (tx: { query: typeof query }) => Promise<unknown>) => work({ query }),
    } as unknown as TenantTransaction;
    const repository = new PostgresProcessingJobRepository();

    await repository.markRetryWait('tenant', 'actor', 'job', 'DOCUMENT_PARSE_FAILED', transaction);
    expect(query.mock.calls[0]?.[1]).toEqual([
      'tenant', 'actor', 'job', 'retry_wait', 'DOCUMENT_PARSE_FAILED', 'Document processing failed.',
    ]);

    await repository.markSucceeded('tenant', 'actor', 'job', 'worker-v1', transaction);
    expect(query.mock.calls[1]?.[0]).toContain('error_code = NULL, last_error = NULL');
  });
});
