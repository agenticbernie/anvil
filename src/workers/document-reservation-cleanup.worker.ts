import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import {
  DOCUMENT_RESERVATION_MAINTENANCE_REPOSITORY,
  STORAGE_PROVIDER,
} from '../modules/documents/documents.tokens.js';
import type {
  DocumentReservationMaintenanceRepository,
  StorageProvider,
} from '../modules/documents/application/document.types.js';

@Injectable()
export class DocumentReservationCleanupWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(DocumentReservationCleanupWorker.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    @Inject(DOCUMENT_RESERVATION_MAINTENANCE_REPOSITORY)
    private readonly reservations: DocumentReservationMaintenanceRepository,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => {
      void this.cleanupExpiredBatch().catch((error: unknown) => this.logFailure(error));
    }, 60_000);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async cleanupExpiredBatch(limit = 100): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    const errors: unknown[] = [];
    let removed = 0;
    try {
      const rows = await this.reservations.claimExpiredReservations(limit);
      for (const row of rows) {
        try {
          await this.storage.deleteObject(row.stagingObjectKey);
          if (row.finalizedObjectKey && row.finalizedObjectKey !== row.stagingObjectKey) {
            await this.storage.deleteObject(row.finalizedObjectKey);
          }
          if (await this.reservations.markExpiredReservationCleanupChecked(row.tenantId, row.documentId)) removed += 1;
        } catch (error) {
          errors.push(error);
        }
      }
      const stagingObjects = await this.reservations.claimStagingCleanupRetries(limit);
      for (const row of stagingObjects) {
        try {
          await this.storage.deleteObject(row.stagingObjectKey);
          if (row.finalizedObjectKey && row.finalizedObjectKey !== row.stagingObjectKey) {
            await this.storage.deleteObject(row.finalizedObjectKey);
          }
          if (await this.reservations.markStagingCleanupChecked(row.tenantId, row.documentId)) removed += 1;
        } catch (error) {
          errors.push(error);
        }
      }
      try {
        await this.reservations.purgeOldRateLimitWindows();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length > 0) throw new AggregateError(errors, 'One or more expired upload reservations could not be cleaned.');
      return removed;
    } finally {
      this.running = false;
    }
  }

  private logFailure(_error: unknown): void {
    this.logger.error('Upload reservation cleanup failed; details omitted.');
  }
}
