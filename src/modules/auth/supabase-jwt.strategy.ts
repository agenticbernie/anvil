import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { Strategy } from 'passport-custom';
import type { Request as ExpressRequest } from 'express'; // 🔥 ĐỔI TÊN ĐỂ TRÁNH TRÙNG VỚI GLOBAL REQUEST
import type { AuthenticatedUser } from './tenant.types.js';

@Injectable()
export class SupabaseJwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;
  private readonly issuer: string;

  constructor(config: ConfigService) {
    super();
    const jwksUrl = config.get<string>('SUPABASE_JWKS_URL') ?? process.env.SUPABASE_JWKS_URL ?? '';
    const supabaseUrl = config.get<string>('SUPABASE_URL') ?? process.env.SUPABASE_URL ?? '';
    const anonKey = config.get<string>('SUPABASE_ANON_KEY') ?? process.env.SUPABASE_ANON_KEY ?? '';

    if (!jwksUrl || !supabaseUrl) {
      throw new Error('SUPABASE_JWKS_URL and SUPABASE_URL are required for JWT verification.');
    }

    const customFetch = (url: string | URL, init?: RequestInit) => {
      return fetch(url, {
        ...init,
        headers: {
          ...(init?.headers as Record<string, string> || {}),
          apikey: anonKey,
        },
      });
    };

    this.jwks = createRemoteJWKSet(new URL(jwksUrl), {
      fetch: customFetch,
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

    } catch (error: any) {
      console.error('❌ [SupabaseJwtStrategy] JWT Verification Failed:', {
        message: error.message,
        code: error.code,
      });
      throw new UnauthorizedException(`Bearer token is invalid or expired. Detail: ${error.message}`);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
