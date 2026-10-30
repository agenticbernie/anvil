import { describe, expect, it, jest } from '@jest/globals';
import type { DocumentReservationMaintenanceRepository, StorageProvider } from '../modules/documents/application/document.types.js';
import { DocumentReservationCleanupWorker } from './document-reservation-cleanup.worker.js';

const row = { tenantId: 'tenant-a', documentId: 'document-a', stagingObjectKey: 'tenants/tenant-a/staging/document-a' };

describe('DocumentReservationCleanupWorker finalized staging cleanup', () => {
  it('removes only leased staging objects and marks successful deletion', async () => {
    const maintenance = {
      claimExpiredReservations: jest.fn(async () => []),
      markExpiredReservationCleanupChecked: jest.fn(async () => false),
      claimStagingCleanupRetries: jest.fn(async () => [row]),
      markStagingCleanupChecked: jest.fn(async () => true),
      purgeOldRateLimitWindows: jest.fn(async () => undefined),
    } as unknown as DocumentReservationMaintenanceRepository;
    const storage = { deleteObject: jest.fn(async () => undefined) } as unknown as StorageProvider;
    const worker = new DocumentReservationCleanupWorker(maintenance, storage);

    await expect(worker.cleanupExpiredBatch()).resolves.toBe(1);

    expect(storage.deleteObject).toHaveBeenCalledWith(row.stagingObjectKey);
    expect(maintenance.markStagingCleanupChecked).toHaveBeenCalledWith(row.tenantId, row.documentId);
    expect(maintenance.markExpiredReservationCleanupChecked).not.toHaveBeenCalled();
  });

  it('leaves failed staging deletes eligible for the next lease after surfacing the failure', async () => {
    const maintenance = {
      claimExpiredReservations: jest.fn(async () => []),
      markExpiredReservationCleanupChecked: jest.fn(async () => false),
      claimStagingCleanupRetries: jest.fn(async () => [row]),
      markStagingCleanupChecked: jest.fn(async () => true),
      purgeOldRateLimitWindows: jest.fn(async () => undefined),
    } as unknown as DocumentReservationMaintenanceRepository;
    const deleteObject = jest.fn<StorageProvider['deleteObject']>()
      .mockRejectedValueOnce(new Error('sensitive R2 response'))
      .mockResolvedValueOnce(undefined);
    const worker = new DocumentReservationCleanupWorker(maintenance, { deleteObject } as unknown as StorageProvider);

    await expect(worker.cleanupExpiredBatch()).rejects.toBeInstanceOf(AggregateError);
    expect(maintenance.markStagingCleanupChecked).not.toHaveBeenCalled();
    await expect(worker.cleanupExpiredBatch()).resolves.toBe(1);
    expect(deleteObject).toHaveBeenCalledTimes(2);
    expect(maintenance.markStagingCleanupChecked).toHaveBeenCalledTimes(1);
  });
});
