export const appConfig = () => ({
  app: {
    nodeEnv: process.env.NODE_ENV ?? 'development',
    port: Number(process.env.PORT ?? 3000),
    logLevel: process.env.LOG_LEVEL ?? 'info',
    apiPrefix: process.env.API_PREFIX ?? 'v1',
    swaggerEnabled: process.env.SWAGGER_ENABLED !== 'false',
    corsOrigins: process.env.CORS_ORIGINS ?? '',
    requestIdHeader: process.env.REQUEST_ID_HEADER ?? 'x-request-id',
  },
});
