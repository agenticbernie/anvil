import { createHmac, timingSafeEqual } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';

const MAX_TIMESTAMP_AGE_SECONDS = 300;

// MVP trusts cryptographic Svix signature verification. For production hardening,
// configure IP allowlisting at the Render/Cloudflare edge using Svix's official IP list.

export function verifyClerkWebhookSignature(
  rawBody: Buffer | undefined,
  headers: { id: string | undefined; timestamp: string | undefined; signature: string | undefined },
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): void {
  if (!rawBody || !headers.id || !headers.timestamp || !headers.signature) {
    throw new BadRequestException('Webhook signature headers or raw body are missing.');
  }
  const timestamp = Number(headers.timestamp);
  if (!Number.isSafeInteger(timestamp) || Math.abs(nowSeconds - timestamp) > MAX_TIMESTAMP_AGE_SECONDS) {
    throw new BadRequestException('Webhook timestamp is outside the allowed window.');
  }

  let key: Buffer;
  try {
    key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  } catch {
    throw new BadRequestException('Webhook signing secret is invalid.');
  }
  if (key.length === 0) throw new BadRequestException('Webhook signing secret is invalid.');

  const signedContent = `${headers.id}.${headers.timestamp}.${rawBody.toString('utf8')}`;
  const expected = createHmac('sha256', key).update(signedContent).digest();
  const signatures = headers.signature.split(/\s+/).flatMap((entry) => {
    const [version, value] = entry.split(',', 2);
    if (version !== 'v1' || !value) return [];
    try { return [Buffer.from(value, 'base64')]; } catch { return []; }
  });
  if (!signatures.some((candidate) => candidate.length === expected.length && timingSafeEqual(candidate, expected))) {
    throw new BadRequestException('Webhook signature is invalid.');
  }
}
