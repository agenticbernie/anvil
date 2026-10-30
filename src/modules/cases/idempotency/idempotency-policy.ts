import { createHash, createHmac } from 'node:crypto';
import { BadRequestException, ConflictException } from '@nestjs/common';

const MAX_CANONICAL_DEPTH = 64;
const MAX_CANONICAL_NODES = 10_000;

export interface IdempotencyClaimRecord {
  readonly requestHash: string;
  readonly responseStatus: number | null;
  readonly responseBody: unknown;
  readonly expiresAt: string;
}

export type IdempotencyDecision =
  | { readonly kind: 'execute' }
  | { readonly kind: 'replay'; readonly status: number; readonly body: unknown };

export function classifyIdempotencyClaim(
  record: IdempotencyClaimRecord | null,
  requestedHashes: string | readonly string[],
  now = new Date(),
): IdempotencyDecision {
  if (!record || Date.parse(record.expiresAt) <= now.getTime()) return { kind: 'execute' };
  const acceptedHashes = typeof requestedHashes === 'string' ? [requestedHashes] : requestedHashes;
  if (!acceptedHashes.includes(record.requestHash)) {
    throw new ConflictException('Idempotency-Key was already used with a different request.');
  }
  if (record.responseStatus === null) throw new ConflictException('An identical request is still in progress.');
  return { kind: 'replay', status: record.responseStatus, body: record.responseBody };
}

export function hashIdempotencyRequest(method: string, route: string, body: unknown, key: Uint8Array): string {
  if (key.byteLength !== 32) throw new TypeError('Idempotency HMAC key must be exactly 32 bytes.');
  return createHmac('sha256', key).update(canonicalRequest(method, route, body), 'utf8').digest('hex');
}

export function hashLegacyIdempotencyRequest(method: string, route: string, body: unknown): string {
  return createHash('sha256').update(canonicalRequest(method, route, body), 'utf8').digest('hex');
}

function canonicalRequest(method: string, route: string, body: unknown): string {
  return `${method.toUpperCase()}\n${route}\n${canonicalJson(body, 0, { count: 0 })}`;
}

function canonicalJson(value: unknown, depth: number, budget: { count: number }): string {
  budget.count += 1;
  if (depth > MAX_CANONICAL_DEPTH || budget.count > MAX_CANONICAL_NODES) {
    throw new BadRequestException('Request body exceeds idempotency canonicalization limits.');
  }
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item, depth + 1, budget)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item, depth + 1, budget)}`);
  return `{${entries.join(',')}}`;
}
