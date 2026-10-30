import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { Strategy } from 'passport-custom';
import type { Request } from 'express';
import type { AuthenticatedUser } from './tenant.types.js';

@Injectable()
export class SupabaseJwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  private readonly jwks: ReturnType<typeof createRemoteJWKSet> | null;
  private readonly issuer: string | null;

  constructor(config: ConfigService) {
    super();
    const jwksUrl = config.get<string>('SUPABASE_JWKS_URL') ?? process.env.SUPABASE_JWKS_URL ?? '';
    const supabaseUrl = config.get<string>('SUPABASE_URL') ?? process.env.SUPABASE_URL ?? '';
    this.jwks = jwksUrl && supabaseUrl ? createRemoteJWKSet(new URL(jwksUrl)) : null;
    this.issuer = jwksUrl && supabaseUrl ? new URL('/auth/v1', `${supabaseUrl.replace(/\/$/, '')}/`).toString() : null;
  }

  async validate(request: Request): Promise<AuthenticatedUser> {
    const authorization = request.headers.authorization;
    const match = authorization?.match(/^Bearer\s+([^\s]+)$/i);
    if (!match?.[1]) throw new UnauthorizedException('Bearer token is required.');
    if (!this.jwks || !this.issuer) throw new UnauthorizedException('Supabase JWT verification is not configured.');

    try {
      const { payload } = await jwtVerify(match[1], this.jwks, {
        issuer: this.issuer,
        audience: 'authenticated',
        algorithms: ['ES256', 'RS256'],
        requiredClaims: ['sub', 'iat', 'exp', 'role'],
      });
      if (payload.role !== 'authenticated' || typeof payload.sub !== 'string' || !isUuid(payload.sub)) {
        throw new UnauthorizedException('JWT claims are not valid for an authenticated Supabase user.');
      }
      const appMetadata = isRecord(payload.app_metadata) ? payload.app_metadata : {};
      return { id: payload.sub, appMetadata };
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
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
