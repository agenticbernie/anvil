import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { createRemoteJWKSet, customFetch as joseCustomFetch, jwtVerify } from 'jose';
import type { FetchImplementation } from 'jose';
import { Strategy } from 'passport-custom';
import type { Request as ExpressRequest } from 'express';
import type { AuthenticatedUser } from './tenant.types.js';

@Injectable()
export class SupabaseJwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  private readonly logger = new Logger(SupabaseJwtStrategy.name);
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;
  private readonly issuer: string;

  constructor(config: ConfigService) {
    super();
    const jwksUrl = config.get<string>('SUPABASE_JWKS_URL') ?? process.env.SUPABASE_JWKS_URL ?? '';
    const supabaseUrl = config.get<string>('SUPABASE_URL') ?? process.env.SUPABASE_URL ?? '';
    const anonKey = config.get<string>('SUPABASE_ANON_KEY') ?? process.env.SUPABASE_ANON_KEY ?? '';

    if (!jwksUrl || !supabaseUrl || !anonKey) {
      throw new Error('SUPABASE_JWKS_URL, SUPABASE_URL, and SUPABASE_ANON_KEY are required for JWT verification.');
    }

    const customFetch: FetchImplementation = async (url, init) => {
      const endpoint = new URL(url);
      const safeEndpoint = `${endpoint.origin}${endpoint.pathname}`;
      const headers = new Headers(init.headers);
      headers.set('apikey', anonKey);
      headers.set('Authorization', `Bearer ${anonKey}`);
      const startedAt = Date.now();
      this.logger.log({ event: 'jwks_fetch_started', endpoint: safeEndpoint });
      try {
        const response = await fetch(url, { ...init, headers });
        const details = { event: 'jwks_fetch_completed', endpoint: safeEndpoint, status: response.status, durationMs: Date.now() - startedAt };
        if (response.ok) this.logger.log(details);
        else this.logger.warn(details);
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
      const { payload } = await jwtVerify(match[1], this.jwks, {
        issuer: this.issuer,
        audience: 'authenticated',
        algorithms: ['ES256', 'RS256', 'HS256'],
        clockTolerance: 10,
      });

      if (payload.role !== 'authenticated' || typeof payload.sub !== 'string' || !isUuid(payload.sub)) {
        throw new UnauthorizedException('JWT claims are not valid for an authenticated Supabase user.');
      }

      const appMetadata = isRecord(payload.app_metadata) ? payload.app_metadata : {};
      return { id: payload.sub, appMetadata };

    } catch (error: unknown) {
      this.logger.warn({ event: 'jwt_verification_failed', errorName: error instanceof Error ? error.name : 'unknown' });
      throw new UnauthorizedException('Bearer token is invalid or expired.');
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
