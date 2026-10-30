import { describe, expect, it, jest } from '@jest/globals';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { lastValueFrom, of, throwError } from 'rxjs';
import { IdempotencyInterceptor } from './idempotency.interceptor.js';
import type { IdempotencyScope } from './idempotency.types.js';
import type { IdempotencyService } from './application/idempotency.service.js';

const scope: IdempotencyScope = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  actorId: '00000000-0000-4000-8000-000000000011',
  key: 'interceptor-key-0001',
  requestHash: 'a'.repeat(64),
};

describe('IdempotencyInterceptor', () => {
  it('retains a claim when the business handler succeeded but response caching failed', async () => {
    const completeError = new Error('database unavailable');
    const service = {
      begin: jest.fn().mockResolvedValue({ kind: 'execute', scope }),
      complete: jest.fn().mockRejectedValue(completeError),
      release: jest.fn().mockResolvedValue(undefined),
    } as unknown as IdempotencyService;
    const interceptor = new IdempotencyInterceptor(service);
    const context = createContext();
    const handler = { handle: jest.fn().mockReturnValue(of({ id: 'case-1' })) } as unknown as CallHandler;

    await expect(lastValueFrom(interceptor.intercept(context, handler))).rejects.toThrow('idempotency claim was retained');
    expect(service.complete).toHaveBeenCalledWith(scope, 201, { id: 'case-1' });
    expect(service.release).not.toHaveBeenCalled();
  });

  it('releases a claim when the business handler itself fails', async () => {
    const handlerError = new Error('business operation failed');
    const service = {
      begin: jest.fn().mockResolvedValue({ kind: 'execute', scope }),
      complete: jest.fn(),
      release: jest.fn().mockResolvedValue(undefined),
    } as unknown as IdempotencyService;
    const interceptor = new IdempotencyInterceptor(service);
    const handler = { handle: jest.fn().mockReturnValue(throwError(() => handlerError)) } as unknown as CallHandler;

    await expect(lastValueFrom(interceptor.intercept(createContext(), handler))).rejects.toBe(handlerError);
    expect(service.release).toHaveBeenCalledWith(scope);
    expect(service.complete).not.toHaveBeenCalled();
  });
});

function createContext(): ExecutionContext {
  const request = {
    headers: { 'idempotency-key': scope.key },
    user: { id: scope.actorId },
    tenantContext: { tenantId: scope.tenantId, actorId: scope.actorId },
    method: 'POST',
    originalUrl: '/v1/cases',
    body: {},
  };
  const response = { statusCode: 201, status: jest.fn() };
  return {
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
  } as unknown as ExecutionContext;
}
