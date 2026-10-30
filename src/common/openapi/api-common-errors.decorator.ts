import { applyDecorators } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';
import { ApiErrorResponseDto } from './api-error-response.dto.js';

const ERROR_RESPONSES = [
  { status: 400, code: 'Bad Request', message: 'Request validation failed.' },
  { status: 401, code: 'Unauthorized', message: 'Authentication is required.' },
  { status: 403, code: 'Forbidden', message: 'The authenticated user is not authorized.' },
  { status: 404, code: 'Not Found', message: 'The requested resource was not found.' },
  { status: 409, code: 'Conflict', message: 'The request conflicts with the current resource state.' },
  { status: 422, code: 'Unprocessable Entity', message: 'The request is valid JSON but cannot be processed.' },
  { status: 500, code: 'Internal Server Error', message: 'An unexpected server error occurred.' },
] as const;

export type ApiErrorStatus = (typeof ERROR_RESPONSES)[number]['status'];

export function ApiCommonErrors(descriptions: Partial<Record<ApiErrorStatus, string>> = {}): MethodDecorator {
  return applyDecorators(...ERROR_RESPONSES.map(({ status, code, message }) => ApiResponse({
    status,
    description: descriptions[status] ?? `${code}: ${message}`,
    type: ApiErrorResponseDto,
    example: {
      statusCode: status,
      message,
      error: code,
    },
  })));
}
