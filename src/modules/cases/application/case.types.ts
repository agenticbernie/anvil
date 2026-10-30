import type { TenantTransaction, UnitOfWork } from '../../../infrastructure/database/tenant-transaction.js';

export const CASE_STATUSES = [
  'draft', 'documents_pending', 'processing', 'memo_ready', 'in_review', 'approved', 'rejected', 'archived',
] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];
export type TenantRole = 'tenant_admin' | 'originator' | 'analyst' | 'reviewer' | 'auditor' | 'viewer';

export interface CreditCase {
  readonly id: string;
  readonly tenantId: string;
  readonly entityId: string;
  readonly caseNumber: string;
  readonly status: CaseStatus;
  readonly currency: string;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
  readonly currentJobId?: string;
}

export interface CreateCaseRecord {
  readonly entityId: string;
  readonly caseNumber: string;
  readonly status: CaseStatus;
  readonly currency: string;
}

export interface CaseCursor {
  readonly createdAt: string;
  readonly id: string;
}

export interface CaseListOptions {
  readonly limit: number;
  readonly cursor?: CaseCursor;
}

export interface CaseListResult {
  readonly records: readonly CreditCase[];
  readonly hasMore: boolean;
}

export interface CaseCreationUsage {
  readonly actorHourlyCreates: number;
  readonly tenantHourlyCreates: number;
  readonly tenantLifetimeCases: number;
}

export interface CaseRepository {
  findById(tenantId: string, actorId: string, caseId: string, transaction: TenantTransaction): Promise<CreditCase | null>;
  findByTenant(tenantId: string, actorId: string, options: CaseListOptions, transaction: TenantTransaction): Promise<CaseListResult>;
  lockAndGetCreationUsage(tenantId: string, actorId: string, transaction: TenantTransaction): Promise<CaseCreationUsage>;
  create(tenantId: string, actorId: string, input: CreateCaseRecord, transaction: TenantTransaction): Promise<CreditCase>;
  updateStatus(tenantId: string, actorId: string, caseId: string, expectedVersion: number, status: CaseStatus, transaction: TenantTransaction): Promise<CreditCase>;
  softDelete(tenantId: string, actorId: string, caseId: string, expectedVersion: number, transaction: TenantTransaction): Promise<CreditCase>;
}

export type CaseNumberGenerator = () => string;
export type CaseUnitOfWork = UnitOfWork;
export type { TenantTransaction };
