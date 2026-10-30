import { Module } from '@nestjs/common';

// Outbox persistence is exported by DocumentsModule; this module is reserved for future outbox APIs.
@Module({})
export class OutboxModule {}
