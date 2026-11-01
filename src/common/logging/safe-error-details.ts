const SAFE_ERROR_NAMES = new Set(['Error', 'TypeError', 'AggregateError', 'UnrecoverableError', 'ReplyError', 'AbortError']);
const SAFE_NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENETUNREACH', 'EAI_AGAIN', 'ENOTFOUND', 'NOAUTH', 'WRONGPASS', 'READONLY']);

export function safeErrorDetails(error: unknown): { errorName: string; errorCode?: string } {
  return getSafeErrorDetails(error, 0);
}

function getSafeErrorDetails(error: unknown, depth: number): { errorName: string; errorCode?: string } {
  if (!(error instanceof Error)) return { errorName: 'UnknownError' };
  const errorName = SAFE_ERROR_NAMES.has(error.name) ? error.name : 'Error';
  const explicitCode = 'code' in error && typeof error.code === 'string' ? error.code : undefined;
  const responseCode = /^(NOAUTH|WRONGPASS|READONLY)\b/.exec(error.message)?.[1];
  const nestedCode = error instanceof AggregateError && depth < 2
    ? error.errors.slice(0, 10).map((nested: unknown) => getSafeErrorDetails(nested, depth + 1).errorCode).find(Boolean)
    : undefined;
  const code = explicitCode ?? responseCode ?? nestedCode;
  return { errorName, ...(code && (SAFE_NETWORK_CODES.has(code) || /^[0-9A-Z]{5}$/.test(code)) ? { errorCode: code } : {}) };
}
