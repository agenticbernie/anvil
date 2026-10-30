import { Global, Module } from '@nestjs/common';
import type { OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { PG_POOL, UNIT_OF_WORK } from './postgres.tokens.js';
import { PostgresUnitOfWork } from './postgres-unit-of-work.js';
import { createDatabaseSslOptions } from './database-ssl-options.js';

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => new Pool({
        connectionString: config.get<string>('database.url') || undefined,
        max: config.get<number>('database.poolMax', 5),
        ssl: createDatabaseSslOptions(
          config.get<boolean>('database.ssl', true),
          config.get<string>('database.url'),
        ),
        application_name: 'anvil-api',
      }),
    },
    {
      provide: UNIT_OF_WORK,
      inject: [PG_POOL],
      useFactory: (pool: Pool) => new PostgresUnitOfWork(pool),
    },
    {
      provide: 'DATABASE_POOL_SHUTDOWN',
      inject: [PG_POOL],
      useFactory: (pool: Pool) => ({ onApplicationShutdown: () => pool.end() } satisfies OnApplicationShutdown),
    },
  ],
  exports: [PG_POOL, UNIT_OF_WORK],
})
export class DatabaseModule {}
