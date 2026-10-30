export const r2Config = () => ({
  r2: {
    endpoint: process.env.R2_ENDPOINT ?? '',
    bucketName: process.env.R2_BUCKET_NAME ?? '',
    region: process.env.R2_REGION ?? 'auto',
    accessKeyId: process.env.R2_ACCESS_KEY_ID ?? '',
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? '',
  },
});
