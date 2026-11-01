import 'reflect-metadata';

import type { OpenAPIObject } from '@nestjs/swagger';
import { beforeAll, describe, expect, it } from '@jest/globals';
import { createOpenApiDocument } from './openapi-document.js';

const businessOperations = [
  ['post', '/v1/entities', true],
  ['post', '/v1/cases', true],
  ['get', '/v1/cases', false],
  ['get', '/v1/cases/{id}', false],
  ['patch', '/v1/cases/{id}', true],
  ['post', '/v1/cases/{id}/archive', true],
  ['post', '/v1/cases/{caseId}/documents/presign', true],
  ['post', '/v1/documents/{documentId}/confirm-upload', true],
  ['patch', '/v1/facts/{factId}', true],
  ['post', '/v1/cases/{caseId}/memos/generate', true],
  ['get', '/v1/memos/{memoId}', false],
  ['post', '/v1/memos/{memoId}/approve', true],
] as const;

const requiredErrors = ['400', '401', '403', '404', '409', '422', '500'];
const healthOperations = [
  ['get', '/health/live'],
  ['get', '/health/ready'],
  ['get', '/health/dependencies'],
] as const;
const idempotentOperations = [
  ['post', '/v1/cases'], ['patch', '/v1/cases/{id}'], ['post', '/v1/cases/{id}/archive'],
  ['patch', '/v1/facts/{factId}'], ['post', '/v1/cases/{caseId}/memos/generate'],
] as const;
const noStoreOperations = [
  ['get', '/v1/memos/{memoId}', '200'],
  ['post', '/v1/memos/{memoId}/approve', '200'],
  ['patch', '/v1/facts/{factId}', '200'],
  ['post', '/v1/cases/{caseId}/documents/presign', '201'],
] as const;

describe('generated OpenAPI contract', () => {
  let document: OpenAPIObject;

  beforeAll(async () => {
    document = await createOpenApiDocument();
  });

  it.each(businessOperations)('%s %s has a described tagged operation and every documented error example', (method, path) => {
    const operation = document.paths[path]?.[method];
    expect(operation?.summary).toBeTruthy();
    expect(operation?.description).toBeTruthy();
    expect(operation?.tags?.length).toBeGreaterThan(0);
    expect(operation?.security).toContainEqual({ bearer: [] });
    expect(operation?.parameters).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'x-tenant-id', in: 'header', required: true })]));
    for (const status of requiredErrors) {
      const response = operation?.responses[status];
      expect(response?.description).toBeTruthy();
      expect(response?.content?.['application/json']?.example).toBeTruthy();
    }
  });

  it.each(businessOperations.filter(([, , hasBody]) => hasBody))('%s %s publishes a request body example', (method, path) => {
    const requestBody = document.paths[path]?.[method]?.requestBody;
    expect(requestBody).toBeTruthy();
    expect(requestBody && '$ref' in requestBody).toBe(false);
    if (requestBody && !('$ref' in requestBody)) {
      expect(requestBody.content['application/json']?.examples).toBeTruthy();
    }
  });

  it('documents the memo generation rate limit response and example', () => {
    const response = document.paths['/v1/cases/{caseId}/memos/generate']?.post?.responses['429'];
    expect(response?.description).toContain('hourly request budget');
    expect(response?.content?.['application/json']?.example).toMatchObject({ statusCode: 429, error: 'Too Many Requests' });
    expect(document.paths['/v1/cases/{caseId}/memos/generate']?.post?.responses['409']?.description)
      .toContain('100,000 memo generation requests');
  });

  it('documents case creation hourly and lifetime budgets', () => {
    const create = document.paths['/v1/cases']?.post;
    expect(create?.responses['429']?.description).toContain('hourly request budget');
    expect(create?.responses['429']?.content?.['application/json']?.example)
      .toMatchObject({ statusCode: 429, error: 'Too Many Requests' });
    expect(create?.responses['409']?.description).toContain('lifetime case limit');
  });

  it('documents fact review hourly and lifetime budgets', () => {
    const update = document.paths['/v1/facts/{factId}']?.patch;
    expect(update?.responses['429']?.description).toContain('hourly budget');
    expect(update?.responses['429']?.content?.['application/json']?.example)
      .toMatchObject({ statusCode: 429, error: 'Too Many Requests' });
    expect(update?.responses['409']?.description).toContain('lifetime fact review update cap');
  });

  it('documents document upload hourly and lifetime budgets', () => {
    const presign = document.paths['/v1/cases/{caseId}/documents/presign']?.post;
    expect(presign?.responses['429']?.description).toContain('hourly upload budget');
    expect(presign?.responses['429']?.content?.['application/json']?.example)
      .toMatchObject({ statusCode: 429, error: 'Too Many Requests' });
    expect(presign?.responses['409']?.description).toContain('10 GiB');
  });

  it.each(noStoreOperations)('%s %s documents the no-store response header', (method, path, status) => {
    const response = document.paths[path]?.[method]?.responses[status];
    expect(response?.headers?.['Cache-Control']).toMatchObject({
      description: expect.stringContaining('no-store'),
      schema: { example: 'no-store' },
    });
  });

  it('documents every signed upload header including the AES-GCM ciphertext length', () => {
    const example = document.paths['/v1/cases/{caseId}/documents/presign']?.post?.responses['201']
      ?.content?.['application/json']?.example as { requiredHeaders?: Record<string, string> } | undefined;
    expect(example?.requiredHeaders).toMatchObject({
      'content-length': '1048592',
      'content-type': 'application/pdf',
      'x-amz-meta-sha256': expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it.each(healthOperations)('%s %s has an operation description and response example', (method, path) => {
    const operation = document.paths[path]?.[method];
    expect(operation?.summary).toBeTruthy();
    expect(operation?.description).toBeTruthy();
    const response = operation?.responses[path.endsWith('dependencies') ? '501' : '200'];
    expect(response?.description).toBeTruthy();
    expect(response?.content?.['application/json']?.example).toBeTruthy();
  });

  it.each(idempotentOperations)('%s %s declares the required idempotency key header', (method, path) => {
    const operation = document.paths[path]?.[method];
    expect(operation?.parameters).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Idempotency-Key', in: 'header', required: true })]));
  });

  it('uses stable named DTO components for generated client types', () => {
    expect(Object.keys(document.components?.schemas ?? {})).toEqual(expect.arrayContaining([
      'ApiErrorResponseDto', 'CreateCaseDto', 'CreateEntityDto', 'EntityResponseDto', 'CreditCaseResponseDto', 'UpdateFactDto', 'MemoVersionResponseDto',
    ]));
  });
});
