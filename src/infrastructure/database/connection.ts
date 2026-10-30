// Database connection adapter is introduced with the first repository use case.
export interface DatabaseConnectionOptions {
  readonly connectionString: string;
  readonly ssl: boolean;
  readonly maxConnections: number;
}
