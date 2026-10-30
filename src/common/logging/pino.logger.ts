import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { REDACTED_VALUE, SENSITIVE_LOG_FIELDS } from './redact-fields.js';

export function createPinoLoggerOptions(config: ConfigService) {
  const requestIdHeader = config.get<string>('app.requestIdHeader', 'x-request-id');
  const requestIdHeaderPath = `req.headers[${JSON.stringify(requestIdHeader.toLowerCase())}]`;

  return {
    pinoHttp: {
      level: config.get<string>('app.logLevel', 'info'),
      redact: {
        paths: [...SENSITIVE_LOG_FIELDS, requestIdHeaderPath],
        censor: REDACTED_VALUE,
      },
      genReqId: (_request: { headers: Record<string, string | string[] | undefined> }, response: {
        setHeader: (name: string, value: string) => void;
      }): string => {
        const requestId = randomUUID();
        response.setHeader(requestIdHeader, requestId);
        return requestId;
      },
    },
  };
}
