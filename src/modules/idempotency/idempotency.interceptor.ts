import {
  BadRequestException, ConflictException, Injectable, InternalServerErrorException, UnauthorizedException,
  type CallHandler, type ExecutionContext, type NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { catchError, from, mergeMap, of, throwError, type Observable } from 'rxjs';
import type { IdempotencyScope } from './idempotency.types.js';
import { IdempotencyService } from './application/idempotency.service.js';

interface RequestWithTenant extends Request {
  user?: { id?: string };
  tenantContext?: { tenantId: string; actorId: string };
}

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(private readonly idempotency: IdempotencyService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<RequestWithTenant>();
    const response = http.getResponse<Response>();
    const rawKey = request.headers['idempotency-key'];
    if (typeof rawKey !== 'string' || !/^[\x21-\x7e]{8,128}$/.test(rawKey)) {
      throw new BadRequestException('Idempotency-Key header is required and must contain 8 to 128 visible ASCII characters.');
    }
    const tenant = request.tenantContext;
    const actorId = request.user?.id;
    if (!tenant || !actorId) throw new UnauthorizedException('Authenticated tenant context is required.');
    if (tenant.actorId !== actorId) throw new ConflictException('Actor does not match the resolved tenant context.');

    const input = {
      tenantId: tenant.tenantId,
      actorId,
      key: rawKey,
      method: request.method,
      route: request.originalUrl ?? request.url,
      body: request.body,
    };
    return from(this.idempotency.begin(input)).pipe(
      mergeMap((decision) => {
        if (decision.kind === 'replay') {
          response.status(decision.status);
          return of(decision.body);
        }
        return next.handle().pipe(
          catchError((error: unknown) => from(this.idempotency.release(decision.scope).then(
            () => { throw error; },
            (releaseError: unknown) => { throw new AggregateError([error, releaseError], 'Request failed and idempotency claim cleanup also failed.'); },
          ))),
          mergeMap((body) => from(this.idempotency.complete(decision.scope, response.statusCode || 200, body)).pipe(
            mergeMap(() => of(body)),
            catchError((error: unknown) => throwError(() => new InternalServerErrorException(
              'The operation may have succeeded, but response caching failed. The idempotency claim was retained; reconcile the resource before retrying.',
              { cause: error },
            ))),
          )),
        );
      }),
    );
  }
}
