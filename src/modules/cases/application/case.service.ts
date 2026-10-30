import { BadRequestException, ConflictException, ForbiddenException, HttpException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AuditEventRepository } from '../../audit/audit.types.js';
import type { TenantDatabaseScope, UnitOfWork } from '../../../infrastructure/database/tenant-transaction.js';
import type {
  CaseCursor, CaseListOptions, CaseNumberGenerator, CaseRepository, CaseStatus, CreditCase, TenantRole,
} from './case.types.js';

const TRANSITIONS: Readonly<Record<CaseStatus, readonly CaseStatus[]>> = {
  draft: ['documents_pending'], documents_pending: ['processing'], processing: ['memo_ready'],
  memo_ready: ['in_review'], in_review: ['approved', 'rejected'], approved: [], rejected: [], archived: [],
};

export const CASE_CREATION_LIMITS = Object.freeze({ actorPerHour: 10, tenantPerHour: 100, tenantLifetime: 10_000 });

export interface CreateCaseInput { readonly entityId: string; readonly currency: string; }
export interface UpdateCaseStatusInput { readonly status: CaseStatus; readonly version: number; }
export interface ListCasesInput { readonly limit: number; readonly cursor?: string; }
export interface CasePage { readonly items: readonly CreditCase[]; readonly nextCursor: string | null; }

@Injectable()
export class CaseService {
  constructor(
    private readonly cases: CaseRepository,
    private readonly audit: AuditEventRepository,
    private readonly unitOfWork: UnitOfWork,
    private readonly generateCaseNumber: CaseNumberGenerator = defaultCaseNumber,
  ) {}

  async create(tenantId: string, actorId: string, role: TenantRole, input: CreateCaseInput): Promise<CreditCase> {
    this.requireRole(role, ['tenant_admin', 'originator']);
    if (!/^[A-Z]{3}$/.test(input.currency)) throw new BadRequestException('currency must be a three-letter ISO code.');
    const scope = { tenantId, actorId } satisfies TenantDatabaseScope;
    return this.unitOfWork.run(scope, async (transaction) => {
      const usage = await this.cases.lockAndGetCreationUsage(tenantId, actorId, transaction);
      if (usage.tenantLifetimeCases >= CASE_CREATION_LIMITS.tenantLifetime) {
        throw new ConflictException('Tenant case creation limit reached.');
      }
      if (usage.actorHourlyCreates >= CASE_CREATION_LIMITS.actorPerHour
        || usage.tenantHourlyCreates >= CASE_CREATION_LIMITS.tenantPerHour) {
        throw new HttpException('Case creation hourly request budget is exhausted.', HttpStatus.TOO_MANY_REQUESTS);
      }
      const created = await this.cases.create(tenantId, actorId, {
        entityId: input.entityId, caseNumber: this.generateCaseNumber(), status: 'draft', currency: input.currency,
      }, transaction);
      await this.audit.record(tenantId, actorId, {
        type: 'case.created', resourceType: 'credit_case', resourceId: created.id,
        metadata: { caseNumber: created.caseNumber, status: created.status },
      }, transaction);
      return created;
    });
  }

  async list(tenantId: string, actorId: string, input: ListCasesInput): Promise<CasePage> {
    const limit = input.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new BadRequestException('limit must be between 1 and 100.');
    const cursor = input.cursor === undefined ? undefined : decodeCursor(input.cursor);
    const options: CaseListOptions = cursor === undefined ? { limit } : { limit, cursor };
    return this.unitOfWork.run({ tenantId, actorId }, async (transaction) => {
      const page = await this.cases.findByTenant(tenantId, actorId, options, transaction);
      const items = page.records.slice(0, limit);
      const last = items.at(-1);
      return { items, nextCursor: page.hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null };
    });
  }

  async findOne(tenantId: string, actorId: string, caseId: string): Promise<CreditCase> {
    return this.unitOfWork.run({ tenantId, actorId }, async (transaction) => {
      const result = await this.cases.findById(tenantId, actorId, caseId, transaction);
      if (!result) throw new NotFoundException('Credit case not found.');
      return result;
    });
  }

  async updateStatus(tenantId: string, actorId: string, role: TenantRole, caseId: string, input: UpdateCaseStatusInput): Promise<CreditCase> {
    return this.unitOfWork.run({ tenantId, actorId }, async (transaction) => {
      const current = await this.cases.findById(tenantId, actorId, caseId, transaction);
      if (!current) throw new NotFoundException('Credit case not found.');
      if (current.version !== input.version) throw new ConflictException('Case version is stale.');
      if (!TRANSITIONS[current.status].includes(input.status)) throw new BadRequestException('Invalid credit case status transition.');
      if (input.status === 'approved' || input.status === 'rejected') this.requireRole(role, ['tenant_admin', 'reviewer']);
      else this.requireRole(role, ['tenant_admin', 'originator', 'analyst']);

      const updated = await this.cases.updateStatus(tenantId, actorId, caseId, input.version, input.status, transaction);
      await this.audit.record(tenantId, actorId, {
        type: 'case.status_changed', resourceType: 'credit_case', resourceId: updated.id,
        metadata: { from: current.status, to: updated.status, version: updated.version },
      }, transaction);
      return updated;
    });
  }

  async archive(tenantId: string, actorId: string, role: TenantRole, caseId: string, expectedVersion: number): Promise<CreditCase> {
    this.requireRole(role, ['tenant_admin', 'originator']);
    return this.unitOfWork.run({ tenantId, actorId }, async (transaction) => {
      const current = await this.cases.findById(tenantId, actorId, caseId, transaction);
      if (!current) throw new NotFoundException('Credit case not found.');
      if (current.version !== expectedVersion) throw new ConflictException('Case version is stale.');
      if (current.status === 'archived') throw new ConflictException('Credit case is already archived.');
      const archived = await this.cases.softDelete(tenantId, actorId, caseId, expectedVersion, transaction);
      await this.audit.record(tenantId, actorId, {
        type: 'case.archived', resourceType: 'credit_case', resourceId: archived.id,
        metadata: { from: current.status, to: 'archived', version: archived.version },
      }, transaction);
      return archived;
    });
  }

  private requireRole(role: TenantRole, allowed: readonly TenantRole[]): void {
    if (!allowed.includes(role)) throw new ForbiddenException('Role is not allowed to perform this case operation.');
  }
}

function defaultCaseNumber(): string {
  const date = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  return `CS-${date}-${randomUUID().slice(0, 8).toUpperCase()}`;
}

function encodeCursor(cursor: CaseCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(value: string): CaseCursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!isCursor(parsed)) throw new Error('Invalid cursor.');
    return parsed;
  } catch {
    throw new BadRequestException('cursor is invalid.');
  }
}

function isCursor(value: unknown): value is CaseCursor {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.createdAt === 'string' && !Number.isNaN(Date.parse(candidate.createdAt))
    && typeof candidate.id === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate.id);
}
