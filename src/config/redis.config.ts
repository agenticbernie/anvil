export const redisConfig = () => ({
  redis: {
    url: process.env.UPSTASH_REDIS_URL ?? '',
    token: process.env.UPSTASH_REDIS_TOKEN ?? '',
    workerConcurrency: Number(process.env.WORKER_CONCURRENCY ?? 1),
  },
});
