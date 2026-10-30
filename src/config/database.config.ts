export const databaseConfig = () => ({
  database: {
    url: process.env.DATABASE_URL ?? '',
    ssl: process.env.DATABASE_SSL !== 'false',
    poolMax: Number(process.env.DATABASE_POOL_MAX ?? 5),
  },
});
