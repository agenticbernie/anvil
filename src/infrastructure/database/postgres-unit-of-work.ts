import { Injectable } from '@nestjs/common';
import type { Pool, PoolClient, QueryResult as PgQueryResult } from 'pg';
import type { TenantDatabaseScope, TenantTransaction, UnitOfWork } from './tenant-transaction.js';

@Injectable()
export class PostgresUnitOfWork implements UnitOfWork {
  constructor(private readonly pool: Pool) {}

  async run<T>(scope: TenantDatabaseScope, work: (transaction: TenantTransaction) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let transactionStarted = false;
    try {
      await client.query('BEGIN');
      transactionStarted = true;
      await this.applyAuthenticatedContext(client, scope);
      const result = await work(this.transaction(client));
      await client.query('COMMIT');
      transactionStarted = false;
      return result;
    } catch (error) {
      if (transactionStarted) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], 'Database operation and rollback both failed.');
        }
      }
      throw error;
    } finally {
      client.release();
    }
  }

  private async applyAuthenticatedContext(client: PoolClient, scope: TenantDatabaseScope): Promise<void> {
    await client.query('SET LOCAL ROLE authenticated');
    const claims = JSON.stringify({ sub: scope.actorId, role: 'authenticated', aud: 'authenticated' });
    await client.query(
      "SELECT set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', $2, true)",
      [scope.actorId, claims],
    );
  }

  private transaction(client: PoolClient): TenantTransaction {
    return {
      query: async <T extends Record<string, unknown>>(sql: string, values: readonly unknown[] = []) => {
        const result: PgQueryResult<T> = await client.query<T>(sql, [...values]);
        return { rows: result.rows, rowCount: result.rowCount ?? 0 };
      },
      withBackendRole: async <T>(work: (transaction: TenantTransaction) => Promise<T>) => {
        await client.query('RESET ROLE');
        await client.query('SET LOCAL ROLE anvil_backend');
        const result = await work(this.transaction(client));
        await client.query('RESET ROLE');
        await client.query('SET LOCAL ROLE authenticated');
        return result;
      },
    };
  }
}
