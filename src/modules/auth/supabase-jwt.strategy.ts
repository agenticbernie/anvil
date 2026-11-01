import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { jwtVerify } from 'jose';
import { Strategy } from 'passport-custom';
import type { Request } from 'express';
import type { AuthenticatedUser } from './tenant.types.js';

@Injectable()
export class SupabaseJwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  private readonly secret: Uint8Array;
  private readonly issuer: string;

  constructor(config: ConfigService) {
    super();
    const jwtSecret = config.get<string>('SUPABASE_JWT_SECRET') ?? process.env.SUPABASE_JWT_SECRET ?? '';
    const supabaseUrl = config.get<string>('SUPABASE_URL') ?? process.env.SUPABASE_URL ?? '';

    if (!jwtSecret) {
      throw new Error('SUPABASE_JWT_SECRET is required for JWT verification.');
    }

    this.secret = new TextEncoder().encode(jwtSecret);
    this.issuer = new URL('/auth/v1', `${supabaseUrl.replace(/\/$/, '')}/`).toString();
  }

  async validate(request: Request): Promise<AuthenticatedUser> {
    const authorization = request.headers.authorization;
    const match = authorization?.match(/^Bearer\s+([^\s]+)$/i);
    if (!match?.[1]) throw new UnauthorizedException('Bearer token is required.');

    try {
      const { payload } = await jwtVerify(match[1], this.secret, {
        issuer: this.issuer,
        audience: 'authenticated',
        algorithms: ['HS256', 'RS256'],
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
