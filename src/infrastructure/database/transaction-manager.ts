export interface TransactionManager<TTransaction> {
  run<T>(operation: (transaction: TTransaction) => Promise<T>): Promise<T>;
}
