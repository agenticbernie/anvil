import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it } from '@jest/globals';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { SupabaseJwtStrategy } from './supabase-jwt.strategy.js';

const userId = '00000000-0000-4000-8000-000000000001';
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('SupabaseJwtStrategy', () => {
  it('verifies the Supabase signature, issuer, audience and authenticated role', async () => {
    const { strategy, sign } = await fixture();
    const token = await sign({ role: 'authenticated', app_metadata: { tenant_id: '00000000-0000-4000-8000-000000000002' } });
    await expect(strategy.validate({ headers: { authorization: `Bearer ${token}` } } as never))
      .resolves.toEqual({ id: userId, appMetadata: { tenant_id: '00000000-0000-4000-8000-000000000002' } });
  });

  it('does not use mutable user_metadata as a tenant authorization claim', async () => {
    const { strategy, sign } = await fixture();
    const token = await sign({ role: 'authenticated', user_metadata: { tenant_id: '00000000-0000-4000-8000-000000000002' } });
    await expect(strategy.validate({ headers: { authorization: `Bearer ${token}` } } as never))
      .resolves.toEqual({ id: userId, appMetadata: {} });
  });

  it('rejects a correctly signed token with a non-authenticated Supabase role', async () => {
    const { strategy, sign } = await fixture();
    const token = await sign({ role: 'service_role' });
    await expect(strategy.validate({ headers: { authorization: `Bearer ${token}` } } as never))
      .rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects malformed bearer tokens', async () => {
    const { strategy } = await fixture();
    await expect(strategy.validate({ headers: { authorization: 'Basic abc' } } as never))
      .rejects.toBeInstanceOf(UnauthorizedException);
  });
});

async function fixture() {
  const { privateKey, publicKey } = await generateKeyPair('ES256');
  const exported = await exportJWK(publicKey);
  const key = { ...exported, kid: 'test-key', alg: 'ES256', use: 'sig' };
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ keys: [key] }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test JWKS server did not bind to a TCP port.');
  const config = new ConfigService({
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_JWKS_URL: `http://127.0.0.1:${address.port}/.well-known/jwks.json`,
  });
  const strategy = new SupabaseJwtStrategy(config);
  const sign = (claims: Record<string, unknown>) => new SignJWT(claims)
    .setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
    .setIssuer('https://example.supabase.co/auth/v1')
    .setAudience('authenticated')
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
  cleanups.push(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  return { strategy, sign };
}
