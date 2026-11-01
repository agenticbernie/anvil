"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import {
  anvilApi,
  type CaseFacts,
  type CaseMemoSummary,
  type CreateCaseRequest,
  type FactReviewStatus,
  type ApproveMemoRequest,
  type UpdateFactRequest,
} from "@/lib/api/client";
import { uploadCaseDocument, type UploadCallbacks } from "@/lib/api/upload";
import { useAuthTenant } from "@/lib/auth/tenant-context";

export function useCases(params: { limit: number; cursor?: string }) {
  const { credentials } = useAuthTenant();
  return useQuery({
    queryKey: ["cases", credentials?.tenantId, credentials?.sessionRevision, params],
    queryFn: ({ signal }) => {
      if (!credentials) throw new Error("Connect an API session to load cases.");
      return anvilApi.CasesController_list(credentials, params, signal);
    },
    enabled: Boolean(credentials),
  });
}

export function useCreateCase() {
  const { credentials } = useAuthTenant();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ body, idempotencyKey }: { body: CreateCaseRequest; idempotencyKey: string }) => {
      if (!credentials) throw new Error("Connect an API session before creating a case.");
      return anvilApi.CasesController_create(credentials, body, idempotencyKey);
    },
    onSuccess: () => {
      if (!credentials) return;
      // Invalidate every cursor page for this tenant/session after creation.
      void queryClient.invalidateQueries({
        queryKey: ["cases", credentials.tenantId, credentials.sessionRevision],
        refetchType: "all",
      });
    },
    gcTime: 0,
  });
}

export function useCase(caseId: string) {
  const { credentials } = useAuthTenant();
  return useQuery({
    queryKey: ["case", credentials?.tenantId, credentials?.sessionRevision, caseId],
    queryFn: ({ signal }) => {
      if (!credentials) throw new Error("Connect an API session to load this case.");
      return anvilApi.CasesController_findOne(credentials, caseId, signal);
    },
    enabled: Boolean(credentials && caseId),
  });
}

export function useCaseDocuments(caseId: string) {
  const { credentials } = useAuthTenant();
  return useQuery({
    queryKey: ["case-documents", credentials?.tenantId, credentials?.sessionRevision, caseId],
    queryFn: ({ signal }) => {
      if (!credentials) throw new Error("Connect an API session to load documents.");
      return anvilApi.CaseDocumentsController_listForCase(credentials, caseId, signal);
    },
    enabled: Boolean(credentials && caseId),
    staleTime: 0,
  });
}

export function useCaseFacts(caseId: string, reviewStatus?: FactReviewStatus) {
  const { credentials } = useAuthTenant();
  return useQuery({
    queryKey: ["case-facts", credentials?.tenantId, credentials?.sessionRevision, caseId, reviewStatus ?? "all"],
    queryFn: ({ signal }) => {
      if (!credentials) throw new Error("Connect an API session to load extracted facts.");
      return anvilApi.FactsController_listForCase(credentials, caseId, reviewStatus, signal);
    },
    enabled: Boolean(credentials && caseId),
    staleTime: 0,
    // No persistence plugin is configured; decrypted values are removed as soon as this query is unused.
    gcTime: 0,
  });
}

export function useCaseMemos(caseId: string) {
  const { credentials } = useAuthTenant();
  return useQuery({
    queryKey: ["case-memos", credentials?.tenantId, credentials?.sessionRevision, caseId],
    queryFn: async ({ signal }): Promise<CaseMemoSummary[]> => {
      if (!credentials) throw new Error("Connect an API session to load memos.");
      const response = await anvilApi.MemosController_listForCase(credentials, caseId, signal);
      // Only non-sensitive memo metadata enters TanStack Query; list content stays out of the cache.
      return response.items.map(({ id, versionNumber, status, approvedAt }) => ({ id, versionNumber, status, approvedAt }));
    },
    enabled: Boolean(credentials && caseId),
    staleTime: 0,
    // This endpoint may return decrypted memo content. Keep it in memory only, without persistence.
    gcTime: 0,
  });
}

export function useJobStatus(jobId?: string) {
  const { credentials } = useAuthTenant();
  return useQuery({
    queryKey: ["job", credentials?.tenantId, credentials?.sessionRevision, jobId],
    queryFn: ({ signal }) => {
      if (!credentials || !jobId) throw new Error("A job ID and API session are required.");
      return anvilApi.JobsController_get(credentials, jobId, signal);
    },
    enabled: Boolean(credentials && jobId),
    staleTime: 0,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (status === "succeeded" || status === "failed" || status === "dead_lettered") return false;
      // Stop retrying on non-transient authorization/contract errors; keep polling on 429/5xx.
      const error = query.state.error;
      if (error instanceof Error && "status" in error && [400, 401, 403, 404, 409, 422].includes(Number(error.status))) return false;
      return 3_000;
    },
  });
}

export function useUploadCaseDocument(caseId: string) {
  const { credentials } = useAuthTenant();
  const pendingUploads = useRef(new Map<string, { file: File; callbacks?: UploadCallbacks }>());
  const mutation = useMutation({
    mutationFn: (requestId: string) => {
      if (!credentials) throw new Error("Connect an API session before uploading.");
      const pending = pendingUploads.current.get(requestId);
      if (!pending) throw new Error("The selected file is no longer available. Select it again.");
      return uploadCaseDocument(credentials, caseId, pending.file, pending.callbacks);
    },
    gcTime: 0,
  });

  async function uploadFile(file: File, callbacks?: UploadCallbacks) {
    const requestId = crypto.randomUUID();
    pendingUploads.current.set(requestId, { file, callbacks });
    try {
      return await mutation.mutateAsync(requestId);
    } finally {
      pendingUploads.current.delete(requestId);
    }
  }

  return { ...mutation, uploadFile };
}

export function useGenerateMemo(caseId: string) {
  const { credentials } = useAuthTenant();
  return useMutation({
    mutationFn: (idempotencyKey: string) => {
      if (!credentials) throw new Error("Connect an API session before generating a memo.");
      return anvilApi.MemosController_requestGeneration(credentials, caseId, idempotencyKey);
    },
  });
}

export function useUpdateFact(caseId: string) {
  const { credentials } = useAuthTenant();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      factId,
      body,
      idempotencyKey,
    }: {
      factId: string;
      body: UpdateFactRequest;
      idempotencyKey: string;
    }) => {
      if (!credentials) throw new Error("Connect an API session before updating a fact.");
      return anvilApi.FactsController_update(credentials, factId, body, idempotencyKey);
    },
    onSuccess: (updatedFact) => {
      if (!credentials) return;
      const prefix = ["case-facts", credentials.tenantId, credentials.sessionRevision, caseId] as const;
      for (const [queryKey, cachedFacts] of queryClient.getQueriesData<CaseFacts>({ queryKey: prefix })) {
        const filter = queryKey[4];
        const matchesFilter = filter === "all" || filter === updatedFact.reviewStatus;
        const next = (cachedFacts ?? []).filter((fact) => fact.id !== updatedFact.id);
        if (matchesFilter) next.unshift(updatedFact);
        queryClient.setQueryData<CaseFacts>(queryKey, next);
      }
      void queryClient.invalidateQueries({ queryKey: prefix, refetchType: "all" });
    },
    gcTime: 0,
  });
}

export function useApproveMemo(caseId: string, memoId: string) {
  const { credentials } = useAuthTenant();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: ApproveMemoRequest) => {
      if (!credentials) throw new Error("Connect an API session before approving a memo.");
      return anvilApi.MemosController_approve(credentials, memoId, body);
    },
    onSuccess: (approvedMemo) => {
      if (!credentials) return;
      queryClient.setQueryData(["memo", credentials.tenantId, credentials.sessionRevision, memoId], approvedMemo);
      queryClient.setQueryData<CaseMemoSummary[]>(
        ["case-memos", credentials.tenantId, credentials.sessionRevision, caseId],
        (memos) => memos?.map((memo) => memo.id === approvedMemo.id ? { ...memo, status: approvedMemo.status, approvedAt: approvedMemo.approvedAt } : memo),
      );
      void queryClient.invalidateQueries({
        queryKey: ["case-memos", credentials.tenantId, credentials.sessionRevision, caseId],
        refetchType: "all",
      });
    },
    gcTime: 0,
  });
}

export function useMemoVersion(memoId: string, enabled: boolean) {
  const { credentials } = useAuthTenant();
  return useQuery({
    queryKey: ["memo", credentials?.tenantId, credentials?.sessionRevision, memoId],
    queryFn: ({ signal }) => {
      if (!credentials) throw new Error("Connect an API session to view this memo.");
      return anvilApi.MemosController_get(credentials, memoId, signal);
    },
    enabled: Boolean(credentials && memoId && enabled),
    staleTime: 0,
    // In-memory only, removed immediately when unused; fetch itself uses cache: no-store.
    gcTime: 0,
    refetchOnMount: "always",
  });
}

export function useClearAnvilQueries() {
  const queryClient = useQueryClient();
  return () => queryClient.clear();
}
