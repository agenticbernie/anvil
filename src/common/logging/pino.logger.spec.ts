import { describe, expect, it } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import { Writable } from 'node:stream';
import pino from 'pino';
import { REDACTED_VALUE } from './redact-fields.js';
import { createPinoLoggerOptions } from './pino.logger.js';

describe('Pino request ID safety', () => {
  it('generates the request ID on the server and redacts the configured caller header', () => {
    let output = '';
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    });
    const requestIdHeader = 'x-correlation-id';
    const suppliedSensitiveValue = 'borrower-tax-id-12345';
    const idempotencyKey = 'idem-user-secret-value-123';
    const options = createPinoLoggerOptions(new ConfigService({ app: { requestIdHeader } })).pinoHttp;
    let responseRequestId = '';
    const requestId = options.genReqId(
      { headers: { [requestIdHeader]: suppliedSensitiveValue } },
      { setHeader: (_name, value) => { responseRequestId = value; } },
    );
    const logger = pino({
      redact: options.redact,
      serializers: { req: pino.stdSerializers.req },
    }, destination);
    logger.info({
      req: {
        id: requestId,
        method: 'GET',
        url: '/health/live',
        headers: { [requestIdHeader]: suppliedSensitiveValue, 'idempotency-key': idempotencyKey },
        socket: { remoteAddress: '127.0.0.1', remotePort: 3000 },
      },
    });

    const record = JSON.parse(output) as { req: { id: string; headers: Record<string, string> } };
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(responseRequestId).toBe(requestId);
    expect(record.req.id).toBe(requestId);
    expect(record.req.headers[requestIdHeader]).toBe(REDACTED_VALUE);
    expect(record.req.headers['idempotency-key']).toBe(REDACTED_VALUE);
    expect(output).not.toContain(suppliedSensitiveValue);
    expect(output).not.toContain(idempotencyKey);
  });
});
