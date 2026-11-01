import type { components, paths } from "./schema";
import type { ApiCredentials } from "@/lib/auth/tenant-context";

// These aliases are indexed from generated OpenAPI types. Keep endpoint payloads and
// responses out of handwritten interfaces so contract changes fail during typecheck.
export type CreditCase = paths["/v1/cases"]["get"]["responses"]["200"]["content"]["application/json"]["items"][number];
export type CasePage = paths["/v1/cases"]["get"]["responses"]["200"]["content"]["application/json"];
export type CaseDetail = paths["/v1/cases/{id}"]["get"]["responses"]["200"]["content"]["application/json"];
export type CreateCaseRequest = components["schemas"]["CreateCaseDto"];
export type CreatedCase = paths["/v1/cases"]["post"]["responses"]["201"]["content"]["application/json"];
export type CreateEntityRequest = components["schemas"]["CreateEntityDto"];
export type CreatedEntity = paths["/v1/entities"]["post"]["responses"]["201"]["content"]["application/json"];
export type CaseDocuments = paths["/v1/cases/{caseId}/documents"]["get"]["responses"]["200"]["content"]["application/json"];
export type CaseDocument = CaseDocuments["items"][number];
export type CaseFacts = paths["/v1/cases/{caseId}/facts"]["get"]["responses"]["200"]["content"]["application/json"];
export type CaseFact = CaseFacts[number];
export type CaseMemos = paths["/v1/cases/{caseId}/memos"]["get"]["responses"]["200"]["content"]["application/json"];
export type CaseMemoSummary = Pick<CaseMemos["items"][number], "id" | "versionNumber" | "status" | "approvedAt">;
export type JobStatus = paths["/v1/jobs/{jobId}"]["get"]["responses"]["200"]["content"]["application/json"];
export type FactReviewStatus = NonNullable<paths["/v1/cases/{caseId}/facts"]["get"]["parameters"]["query"]>["review_status"];
export type PresignDocumentRequest = components["schemas"]["PresignDocumentDto"];
export type PresignedDocument = paths["/v1/cases/{caseId}/documents/presign"]["post"]["responses"]["201"]["content"]["application/json"];
export type ConfirmedDocument = paths["/v1/documents/{documentId}/confirm-upload"]["post"]["responses"]["202"]["content"]["application/json"];
export type MemoAccepted = paths["/v1/cases/{caseId}/memos/generate"]["post"]["responses"]["202"]["content"]["application/json"];
export type MemoVersion = paths["/v1/memos/{memoId}"]["get"]["responses"]["200"]["content"]["application/json"];
export type UpdateFactRequest = components["schemas"]["UpdateFactDto"];
export type UpdatedFact = paths["/v1/facts/{factId}"]["patch"]["responses"]["200"]["content"]["application/json"];
export type ApproveMemoRequest = components["schemas"]["ApproveMemoDto"];
export type ApprovedMemo = paths["/v1/memos/{memoId}/approve"]["post"]["responses"]["200"]["content"]["application/json"];
export type ApiErrorBody = components["schemas"]["ApiErrorResponseDto"];
export type TenantMapping = paths["/v1/tenants/by-clerk-org"]["get"]["responses"]["200"]["content"]["application/json"];

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const safeStatusMessages: Record<number, string> = {
  400: "The request was rejected. Review the supplied values and try again.",
  401: "Your sign-in session is missing or expired. Sign in again.",
  403: "This account does not have access to the selected tenant or action.",
  404: "The requested record was not found in this tenant.",
  409: "A conflict occurred. Reconcile the resource state before retrying; a mutation may already have committed.",
  422: "The request cannot be processed with the current values.",
  429: "The request limit has been reached. Wait before trying again.",
  500: "An unexpected API error occurred. Try again later.",
};

function apiBaseUrl() {
  const value = process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/+$/, "");
  if (!value) throw new Error("Set NEXT_PUBLIC_API_BASE_URL before calling the Anvil API.");
  return value;
}

async function requestJson<T>(
  path: string,
  credentials: ApiCredentials,
  init: RequestInit = {},
  idempotencyKey?: string,
): Promise<T> {
  const headers = new Headers(init.headers);
  let accessToken: string | null;
  try {
    accessToken = await credentials.getAccessToken();
  } catch {
    throw new ApiError(401, safeStatusMessages[401]);
  }
  if (!accessToken) throw new ApiError(401, safeStatusMessages[401]);
  headers.set("Accept", "application/json");
  headers.set("Authorization", `Bearer ${accessToken}`);
  headers.set("x-tenant-id", credentials.tenantId);
  if (init.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (idempotencyKey) headers.set("Idempotency-Key", idempotencyKey);

  const response = await fetch(`${apiBaseUrl()}${path}`, {
    ...init,
    headers,
    cache: "no-store",
  });

  if (!response.ok) {
    // Do not render backend details or stack traces; the contract defines safe status-based feedback.
    throw new ApiError(
      response.status,
      safeStatusMessages[response.status] ?? "The API request could not be completed.",
    );
  }
  return (await response.json()) as T;
}

function encodePathPart(value: string) {
  return encodeURIComponent(value);
}

export const anvilApi = {
  async TenantsController_getByClerkOrg(accessToken: string, organizationId: string, signal?: AbortSignal): Promise<TenantMapping> {
    const query = new URLSearchParams({ org_id: organizationId });
    const response = await fetch(`${apiBaseUrl()}/v1/tenants/by-clerk-org?${query.toString()}`, {
      method: "GET",
      headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` },
      signal,
      cache: "no-store",
    });
    if (!response.ok) {
      throw new ApiError(response.status, safeStatusMessages[response.status] ?? "The tenant could not be resolved.");
    }
    const result = await response.json() as TenantMapping;
    if (!isUuid(result.tenant_id)) throw new ApiError(502, "The API returned an invalid tenant mapping.");
    return result;
  },

  CasesController_list(
    credentials: ApiCredentials,
    params: { limit?: number; cursor?: string },
    signal?: AbortSignal,
  ) {
    const query = new URLSearchParams();
    if (params.limit !== undefined) query.set("limit", String(params.limit));
    if (params.cursor !== undefined) query.set("cursor", params.cursor);
    const suffix = query.size ? `?${query.toString()}` : "";
    return requestJson<CasePage>(`/v1/cases${suffix}`, credentials, { method: "GET", signal });
  },

  CasesController_create(credentials: ApiCredentials, body: CreateCaseRequest, idempotencyKey: string) {
    return requestJson<CreatedCase>(
      "/v1/cases",
      credentials,
      { method: "POST", body: JSON.stringify(body) },
      idempotencyKey,
    );
  },

  EntitiesController_create(credentials: ApiCredentials, body: CreateEntityRequest) {
    return requestJson<CreatedEntity>("/v1/entities", credentials, {
      method: "POST",
      body: JSON.stringify(body),
    });
  },

  CasesController_findOne(credentials: ApiCredentials, id: string, signal?: AbortSignal) {
    return requestJson<CaseDetail>(`/v1/cases/${encodePathPart(id)}`, credentials, {
      method: "GET",
      signal,
    });
  },

  CaseDocumentsController_listForCase(credentials: ApiCredentials, caseId: string, signal?: AbortSignal) {
    return requestJson<CaseDocuments>(`/v1/cases/${encodePathPart(caseId)}/documents`, credentials, {
      method: "GET",
      signal,
    });
  },

  FactsController_listForCase(
    credentials: ApiCredentials,
    caseId: string,
    reviewStatus?: FactReviewStatus,
    signal?: AbortSignal,
  ) {
    const query = new URLSearchParams();
    if (reviewStatus) query.set("review_status", reviewStatus);
    const suffix = query.size ? `?${query.toString()}` : "";
    return requestJson<CaseFacts>(`/v1/cases/${encodePathPart(caseId)}/facts${suffix}`, credentials, {
      method: "GET",
      signal,
    });
  },

  FactsController_update(
    credentials: ApiCredentials,
    factId: string,
    body: UpdateFactRequest,
    idempotencyKey: string,
  ) {
    return requestJson<UpdatedFact>(
      `/v1/facts/${encodePathPart(factId)}`,
      credentials,
      { method: "PATCH", body: JSON.stringify(body) },
      idempotencyKey,
    );
  },

  MemosController_listForCase(credentials: ApiCredentials, caseId: string, signal?: AbortSignal) {
    return requestJson<CaseMemos>(`/v1/cases/${encodePathPart(caseId)}/memos`, credentials, {
      method: "GET",
      signal,
    });
  },

  JobsController_get(credentials: ApiCredentials, jobId: string, signal?: AbortSignal) {
    return requestJson<JobStatus>(`/v1/jobs/${encodePathPart(jobId)}`, credentials, {
      method: "GET",
      signal,
    });
  },

  CaseDocumentsController_presign(credentials: ApiCredentials, caseId: string, body: PresignDocumentRequest) {
    return requestJson<PresignedDocument>(
      `/v1/cases/${encodePathPart(caseId)}/documents/presign`,
      credentials,
      { method: "POST", body: JSON.stringify(body) },
    );
  },

  DocumentsController_confirmUpload(
    credentials: ApiCredentials,
    documentId: string,
    sha256: string,
  ) {
    return requestJson<ConfirmedDocument>(
      `/v1/documents/${encodePathPart(documentId)}/confirm-upload`,
      credentials,
      { method: "POST", body: JSON.stringify({ sha256 }) },
    );
  },

  MemosController_requestGeneration(credentials: ApiCredentials, caseId: string, idempotencyKey: string) {
    return requestJson<MemoAccepted>(
      `/v1/cases/${encodePathPart(caseId)}/memos/generate`,
      credentials,
      { method: "POST", body: JSON.stringify({}) },
      idempotencyKey,
    );
  },

  MemosController_get(credentials: ApiCredentials, memoId: string, signal?: AbortSignal) {
    return requestJson<MemoVersion>(`/v1/memos/${encodePathPart(memoId)}`, credentials, {
      method: "GET",
      signal,
    });
  },

  MemosController_approve(credentials: ApiCredentials, memoId: string, body: ApproveMemoRequest) {
    return requestJson<ApprovedMemo>(
      `/v1/memos/${encodePathPart(memoId)}/approve`,
      credentials,
      { method: "POST", body: JSON.stringify(body) },
    );
  },
};

function isUuid(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
