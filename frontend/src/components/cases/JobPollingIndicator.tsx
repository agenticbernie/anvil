"use client";

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Badge } from "@astryxdesign/core/Badge";
import { useToast } from "@astryxdesign/core/Toast";
import { useJobStatus } from "@/hooks/useCases";
import type { CreditCase } from "@/lib/api/client";
import { useAuthTenant } from "@/lib/auth/tenant-context";

const safeJobMessages: Record<string, string> = {
  DOCUMENT_CHECKSUM_MISMATCH: "The uploaded file checksum did not match. Upload the file again.",
  DOCUMENT_ENCRYPTION_FAILED: "The file could not be encrypted. Upload the file again.",
  DOCUMENT_PARSE_FAILED: "The document could not be processed. Review the file and retry.",
};

type JobId = NonNullable<CreditCase["currentJobId"]>;

function isTerminal(status: string) {
  return status === "succeeded" || status === "failed" || status === "dead_lettered";
}

function statusVariant(status: string) {
  if (status === "succeeded") return "success" as const;
  if (status === "failed" || status === "dead_lettered") return "error" as const;
  if (status === "processing") return "info" as const;
  return "warning" as const;
}

function statusLabel(status: string) {
  return status.replaceAll("_", " ");
}

export function JobPollingIndicator({ caseId, jobId }: { caseId: CreditCase["id"]; jobId?: JobId }) {
  const { credentials } = useAuthTenant();
  const queryClient = useQueryClient();
  const toast = useToast();
  const query = useJobStatus(jobId);
  const job = query.data;
  const terminal = Boolean(job && isTerminal(job.status));

  useEffect(() => {
    if (!query.error) return;
    toast({ body: query.error.message, type: "error", uniqueID: `job-read-error-${jobId ?? "none"}` });
  }, [jobId, query.error, toast]);

  useEffect(() => {
    if (!terminal || !credentials) return;
    // The case, facts, documents, and memo panels stay mounted, so terminal updates refresh their active queries.
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: ["case", credentials.tenantId, credentials.sessionRevision, caseId], refetchType: "all" }),
      queryClient.invalidateQueries({ queryKey: ["case-facts", credentials.tenantId, credentials.sessionRevision, caseId], refetchType: "all" }),
      queryClient.invalidateQueries({ queryKey: ["case-documents", credentials.tenantId, credentials.sessionRevision, caseId], refetchType: "all" }),
      queryClient.invalidateQueries({ queryKey: ["case-memos", credentials.tenantId, credentials.sessionRevision, caseId], refetchType: "all" }),
    ]);
  }, [caseId, credentials, job?.status, queryClient, terminal]);

  if (!jobId) {
    return <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-500">No current processing job is attached to this case.</div>;
  }

  if (query.isPending) {
    return <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600" role="status"><Spinner /> Loading job status…</div>;
  }

  if (query.isError || !job) {
    return <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800" role="alert">{query.error?.message ?? "Job status could not be loaded."}</div>;
  }

  const failed = job.status === "failed" || job.status === "dead_lettered";
  const progress = typeof job.progress === "number" ? Math.min(100, Math.max(0, job.progress)) : undefined;

  return (
    <section className={`rounded-xl border p-4 ${failed ? "border-rose-200 bg-rose-50" : "border-slate-200 bg-white"}`} aria-live="polite">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          {job.status === "processing" && <Spinner />}
          <div>
            <p className="text-sm font-semibold capitalize text-slate-900">{statusLabel(job.status)}</p>
            <p className="mt-1 font-mono text-[10px] text-slate-500">Job {job.id}</p>
          </div>
        </div>
        <Badge label={statusLabel(job.status)} variant={statusVariant(job.status)} />
      </div>

      {progress !== undefined && (
        <div className="mt-4">
          <div className="mb-1.5 flex justify-between text-xs text-slate-500"><span>Progress</span><span>{progress}%</span></div>
          <div className="h-2 overflow-hidden rounded-full bg-slate-200" role="progressbar" aria-label="Job progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
            <div className="h-full rounded-full bg-emerald-700 transition-[width] duration-500" style={{ width: `${progress}%` }} />
          </div>
        </div>
      )}

      {job.status === "queued" && <p className="mt-3 text-sm text-slate-600">Waiting for background processing to start.</p>}
      {job.status === "retry_wait" && <p className="mt-3 text-sm text-slate-600">The job is scheduled for another processing attempt.</p>}
      {failed && (
        <p className="mt-3 text-sm leading-6 text-rose-900" role="alert">
          {safeJobMessages[job.error_code ?? ""] ?? "Processing failed. Review the document and try again. Internal worker details are hidden."}
        </p>
      )}
      {job.status === "succeeded" && <p className="mt-3 text-sm text-emerald-900">Processing completed successfully.</p>}
      {terminal && <p className="mt-3 text-xs text-slate-500">Polling stopped. Case, facts, documents, and memo data were refreshed.</p>}
    </section>
  );
}

function Spinner() {
  return <span className="size-4 animate-spin rounded-full border-2 border-emerald-700/25 border-t-emerald-700" aria-hidden="true" />;
}
