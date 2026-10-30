export interface QueryResult<T> {
  readonly rows: readonly T[];
  readonly rowCount: number;
}

export interface TenantTransaction {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<T>>;
  withBackendRole<T>(work: (transaction: TenantTransaction) => Promise<T>): Promise<T>;
}

export interface TenantDatabaseScope {
  readonly tenantId: string;
  readonly actorId: string;
}

export interface UnitOfWork {
  run<T>(scope: TenantDatabaseScope, work: (transaction: TenantTransaction) => Promise<T>): Promise<T>;
}
