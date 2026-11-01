import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { createRemoteJWKSet, customFetch as joseCustomFetch, decodeProtectedHeader, jwtVerify } from 'jose';
import type { FetchImplementation, JWTPayload } from 'jose';
import { Strategy } from 'passport-custom';
import type { Request as ExpressRequest } from 'express';
import type { AuthenticatedUser } from './tenant.types.js';

@Injectable()
export class SupabaseJwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  private readonly logger = new Logger(SupabaseJwtStrategy.name);
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;
  private readonly issuer: string;
  private readonly jwtSecret: Uint8Array | null;

  constructor(config: ConfigService) {
    super();
    const jwksUrl = config.get<string>('SUPABASE_JWKS_URL') ?? process.env.SUPABASE_JWKS_URL ?? '';
    const supabaseUrl = config.get<string>('SUPABASE_URL') ?? process.env.SUPABASE_URL ?? '';
    const anonKey = config.get<string>('SUPABASE_ANON_KEY') ?? process.env.SUPABASE_ANON_KEY ?? '';
    const jwtSecret = config.get<string>('SUPABASE_JWT_SECRET') ?? process.env.SUPABASE_JWT_SECRET ?? '';
    this.jwtSecret = jwtSecret ? new TextEncoder().encode(jwtSecret) : null;

    if (!jwksUrl || !supabaseUrl) {
      throw new Error('SUPABASE_JWKS_URL and SUPABASE_URL are required for JWT verification.');
    }

    const customFetch: FetchImplementation = async (url, init) => {
      const endpoint = new URL(url);
      const safeEndpoint = `${endpoint.origin}${endpoint.pathname}`;
      const headers = new Headers(init.headers);
      if (anonKey) {
        headers.set('apikey', anonKey);
        headers.set('Authorization', `Bearer ${anonKey}`);
      }
      const startedAt = Date.now();
      this.logger.log({ event: 'jwks_fetch_started', endpoint: safeEndpoint });
      try {
        const response = await fetch(url, { ...init, headers });
        const details = { event: 'jwks_fetch_completed', endpoint: safeEndpoint, status: response.status, durationMs: Date.now() - startedAt };
        if (response.status === 200) this.logger.log(details);
        else this.logger.warn({ ...details, body: await safeErrorBody(response) });
        return response;
      } catch (error) {
        this.logger.error({ event: 'jwks_fetch_failed', endpoint: safeEndpoint, durationMs: Date.now() - startedAt, errorName: error instanceof Error ? error.name : 'unknown' });
        throw error;
      }
    };

    this.jwks = createRemoteJWKSet(new URL(jwksUrl), {
      [joseCustomFetch]: customFetch,
    } as any);

    this.issuer = new URL('/auth/v1', `${supabaseUrl.replace(/\/$/, '')}/`).toString();
  }

  async validate(request: ExpressRequest): Promise<AuthenticatedUser> {
    const authorization = request.headers.authorization;
    const match = authorization?.match(/^Bearer\s+([^\s]+)$/i);
    if (!match?.[1]) throw new UnauthorizedException('Bearer token is required.');

    try {
      const token = match[1];
      const options = {
        issuer: this.issuer, audience: 'authenticated', clockTolerance: 10,
        requiredClaims: ['sub', 'iat', 'exp', 'role'],
      };
      let payload: JWTPayload;
      try {
        ({ payload } = await jwtVerify(token, this.jwks, { ...options, algorithms: ['ES256', 'RS256'] }));
      } catch (jwksError: unknown) {
        if (!this.jwtSecret || decodeProtectedHeader(token).alg !== 'HS256') throw jwksError;
        this.logger.warn({ event: 'jwt_secret_fallback', reason: jwksError instanceof Error ? jwksError.name : 'unknown' });
        ({ payload } = await jwtVerify(token, this.jwtSecret, { ...options, algorithms: ['HS256'] }));
      }
      return this.buildUser(payload);
    } catch (error: unknown) {
      this.logger.warn({ event: 'jwt_verification_failed', errorName: error instanceof Error ? error.name : 'unknown' });
      throw new UnauthorizedException('Bearer token is invalid or expired.');
    }
  }

  private buildUser(payload: JWTPayload): AuthenticatedUser {
    if (payload.role !== 'authenticated' || typeof payload.sub !== 'string' || !isUuid(payload.sub)) {
      throw new UnauthorizedException('JWT claims are not valid for an authenticated Supabase user.');
    }
    return { id: payload.sub, appMetadata: isRecord(payload.app_metadata) ? payload.app_metadata : {} };
  }
}

// Only known gateway messages are logged; arbitrary bodies can contain secrets or PII.
async function safeErrorBody(response: Response): Promise<Record<string, unknown>> {
  const reader = response.clone().body?.getReader();
  if (!reader) return { state: 'empty' };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const chunk = await Promise.race([
      reader.read(),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), 500); }),
    ]);
    if (!chunk?.value) return { state: chunk ? 'empty' : 'timeout' };
    const text = new TextDecoder().decode(chunk.value.subarray(0, 2048));
    const knownMessages = new Set(['Not Found', 'not found', 'Unauthorized', 'Forbidden', 'Invalid API key', 'no Route matched with those values']);
    let message: unknown = text.trim();
    let code: unknown;
    try {
      const parsed: unknown = JSON.parse(text);
      if (isRecord(parsed)) { message = parsed.message ?? parsed.error; code = parsed.code; }
    } catch { /* Non-JSON responses are classified below. */ }
    return {
      message: typeof message === 'string' && knownMessages.has(message) ? message : '[redacted]',
      ...(typeof code === 'string' && /^(?:PGRST\d{3}|40[134])$/.test(code) ? { code } : {}),
      previewOnly: true,
    };
  } catch {
    return { state: 'unreadable' };
  } finally {
    if (timer) clearTimeout(timer);
    void reader.cancel().catch(() => undefined);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
