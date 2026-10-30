"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useParams } from "next/navigation";
import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { useToast } from "@astryxdesign/core/Toast";
import { DocumentList } from "@/components/cases/DocumentList";
import { FactReviewTable } from "@/components/cases/FactReviewTable";
import { JobPollingIndicator } from "@/components/cases/JobPollingIndicator";
import { MemoActions } from "@/components/cases/MemoActions";
import { useCase, useCaseMemos, useGenerateMemo, useMemoVersion } from "@/hooks/useCases";
import { ApiError, type CreditCase } from "@/lib/api/client";
import { useAuthTenant } from "@/lib/auth/tenant-context";

type DetailTab = "documents" | "facts" | "memo";

function caseStatusVariant(status: CreditCase["status"]) {
  if (status === "approved") return "success" as const;
  if (status === "processing" || status === "in_review") return "info" as const;
  if (status === "rejected" || status === "archived") return "neutral" as const;
  return "warning" as const;
}

function memoStatusVariant(status: string) {
  if (status === "approved") return "success" as const;
  if (status === "failed") return "error" as const;
  if (status === "generating") return "info" as const;
  return "warning" as const;
}

export default function CaseDetailPage() {
  const params = useParams<{ caseId: string }>();
  const caseId = params.caseId;
  const { credentials } = useAuthTenant();
  const toast = useToast();
  const caseQuery = useCase(caseId);
  const memoListQuery = useCaseMemos(caseId);
  const generateMutation = useGenerateMemo(caseId);
  const generationKey = useRef<string | null>(null);
  const [activeTab, setActiveTab] = useState<DetailTab>("documents");
  const [generationJobId, setGenerationJobId] = useState("");
  const [uploadJobId, setUploadJobId] = useState("");
  const [memoIdToLoad, setMemoIdToLoad] = useState("");
  const memoQuery = useMemoVersion(memoIdToLoad, Boolean(memoIdToLoad));

  useEffect(() => {
    if (caseQuery.error) toast({ body: caseQuery.error.message, type: "error", uniqueID: "case-detail-error" });
  }, [caseQuery.error, toast]);
  useEffect(() => {
    if (memoListQuery.error) toast({ body: memoListQuery.error.message, type: "error", uniqueID: "memo-list-error" });
  }, [memoListQuery.error, toast]);
  useEffect(() => {
    if (generateMutation.error) toast({ body: generateMutation.error.message, type: "error", uniqueID: "memo-generate-error" });
  }, [generateMutation.error, toast]);
  useEffect(() => {
    if (memoQuery.error) toast({ body: memoQuery.error.message, type: "error", uniqueID: "memo-read-error" });
  }, [memoQuery.error, toast]);
  useEffect(() => {
    // Idempotency keys must not cross users or tenant sessions.
    generationKey.current = null;
  }, [credentials?.sessionRevision]);

  const creditCase = caseQuery.data;

  async function generateMemo() {
    try {
      // Reuse the same key after an uncertain failure; a new key starts only after acceptance.
      generationKey.current ??= crypto.randomUUID();
      const accepted = await generateMutation.mutateAsync(generationKey.current);
      generationKey.current = null;
      setGenerationJobId(accepted.jobId);
      setUploadJobId("");
      toast({ body: "Memo generation accepted", uniqueID: "memo-generation-accepted" });
      await Promise.all([caseQuery.refetch(), memoListQuery.refetch()]);
    } catch {
      // Safe API error feedback is shown inline and through Astryx toast.
    }
  }

  function selectMemo(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const selectedId = new FormData(event.currentTarget).get("memoId");
    if (typeof selectedId === "string") setMemoIdToLoad(selectedId);
  }

  if (!credentials) return <ConnectNotice />;

  if (caseQuery.isPending) {
    return <div className="grid min-h-80 place-items-center text-sm text-slate-500" role="status">Loading case…</div>;
  }

  if (caseQuery.isError || !creditCase) {
    return (
      <section className="rounded-2xl border border-rose-200 bg-white p-7" role="alert">
        <p className="font-semibold text-slate-900">Could not load this case</p>
        <p className="mt-2 text-sm text-slate-500">{caseQuery.error instanceof ApiError ? caseQuery.error.message : "Check your session and API URL, then try again."}</p>
        <Button label="Retry" variant="secondary" size="sm" onClick={() => void caseQuery.refetch()} className="mt-5" />
      </section>
    );
  }

  const tabs: Array<{ id: DetailTab; label: string }> = [
    { id: "documents", label: "Documents" },
    { id: "facts", label: "Extracted facts" },
    { id: "memo", label: "Memo / Status" },
  ];

  return (
    <div className="space-y-7">
      <div>
        <Link href="/cases" className="text-xs font-medium text-slate-500 no-underline hover:text-emerald-800">← All cases</Link>
        <div className="mt-5 flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="eyebrow text-[10px] font-semibold text-emerald-800">Case workspace</p>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <h1 className="text-3xl font-semibold tracking-tight text-slate-950">{creditCase.caseNumber}</h1>
              <Badge label={creditCase.status.replaceAll("_", " ")} variant={caseStatusVariant(creditCase.status)} />
            </div>
            <p className="mt-2 font-mono text-xs text-slate-500">{creditCase.id}</p>
          </div>
          <Button label={caseQuery.isFetching ? "Refreshing…" : "Refresh case"} variant="secondary" size="sm" onClick={() => void caseQuery.refetch()} isDisabled={caseQuery.isFetching} />
        </div>
      </div>

      <section className="grid gap-px overflow-hidden rounded-2xl border border-slate-200 bg-slate-200 sm:grid-cols-3">
        <InfoCell label="Entity ID" value={creditCase.entityId} mono />
        <InfoCell label="Currency" value={creditCase.currency} />
        <InfoCell label="Created" value={new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(creditCase.createdAt))} />
      </section>

      <section className="surface-shadow overflow-hidden rounded-2xl border border-slate-200 bg-white">
        <div className="flex gap-1 overflow-x-auto border-b border-slate-200 px-4 pt-3 md:px-7" role="tablist" aria-label="Case sections">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={`tab-${tab.id}`}
              aria-selected={activeTab === tab.id}
              aria-controls={`panel-${tab.id}`}
              onClick={() => setActiveTab(tab.id)}
              className={`-mb-px flex shrink-0 items-center gap-2 border-b-2 px-3 py-3.5 text-sm font-medium transition-colors ${activeTab === tab.id ? "border-emerald-800 text-emerald-900" : "border-transparent text-slate-500 hover:text-slate-800"}`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Keep panels mounted so terminal job updates can refetch every case resource query. */}
        <div role="tabpanel" id="panel-documents" aria-labelledby="tab-documents" hidden={activeTab !== "documents"} className="min-h-72 p-5 md:p-7">
          <DocumentList caseId={caseId} onUploadAccepted={(result) => { setUploadJobId(result.jobId); setGenerationJobId(""); }} />
        </div>
        <div role="tabpanel" id="panel-facts" aria-labelledby="tab-facts" hidden={activeTab !== "facts"} className="min-h-72 p-5 md:p-7">
          <FactReviewTable caseId={caseId} />
        </div>
        <div role="tabpanel" id="panel-memo" aria-labelledby="tab-memo" hidden={activeTab !== "memo"} className="min-h-72 space-y-7 p-5 md:p-7">
          <div>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <h2 className="font-semibold text-slate-900">Processing status</h2>
                <p className="mt-1 text-sm text-slate-500">Job status refreshes every three seconds until it reaches a terminal state.</p>
              </div>
              <Button label="Generate memo" variant="primary" size="sm" onClick={generateMemo} isDisabled={generateMutation.isPending} isLoading={generateMutation.isPending} />
            </div>
            {generateMutation.isError && <p className="mt-3 text-sm text-rose-700" role="alert">{generateMutation.error.message}</p>}
            <div className="mt-4">
              <JobPollingIndicator caseId={caseId} jobId={generationJobId || uploadJobId || creditCase.currentJobId || undefined} />
            </div>
          </div>

          <section className="border-t border-slate-100 pt-6">
            <h2 className="font-semibold text-slate-900">Credit memo versions</h2>
            <p className="mt-1 text-sm text-slate-500">Latest versions appear first. Approved versions can be opened from this list.</p>
            {memoListQuery.isPending ? (
              <p className="mt-4 text-sm text-slate-500" role="status">Loading memo versions…</p>
            ) : memoListQuery.isError ? (
              <div className="mt-4 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800" role="alert">
                {memoListQuery.error.message}
                <Button label="Retry" variant="secondary" size="sm" onClick={() => void memoListQuery.refetch()} className="ml-3" />
              </div>
            ) : memoListQuery.data?.length ? (
              <ul className="mt-4 divide-y divide-slate-100 rounded-xl border border-slate-200">
                {memoListQuery.data.map((memo) => (
                  <li key={memo.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                    <div>
                      <p className="text-sm font-medium text-slate-800">Version {memo.versionNumber}</p>
                      <p className="mt-1 font-mono text-[10px] text-slate-400">{memo.id}</p>
                    </div>
                    <div className="flex items-center gap-3">
                      <Badge label={memo.status} variant={memoStatusVariant(memo.status)} />
                      <Button label={memo.status === "approved" ? "View approved version" : "View version"} variant="secondary" size="sm" onClick={() => setMemoIdToLoad(memo.id)} />
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-4 rounded-xl border border-dashed border-slate-200 bg-slate-50 p-5 text-center text-sm text-slate-500">No memo versions have been returned for this case.</p>
            )}
          </section>

          {memoIdToLoad && (
            <section className="rounded-xl border border-slate-200 bg-slate-50 p-4 md:p-5" aria-live="polite">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="font-semibold text-slate-900">Memo content</h3>
                  <p className="mt-1 font-mono text-xs text-slate-500">{memoIdToLoad}</p>
                </div>
                <form onSubmit={selectMemo} className="flex items-center gap-2">
                  <input name="memoId" aria-label="Memo version ID" defaultValue={memoIdToLoad} className="h-9 w-56 rounded-lg border border-slate-200 bg-white px-3 font-mono text-xs outline-none focus:border-emerald-700" />
                  <Button label="Load ID" variant="secondary" size="sm" type="submit" />
                </form>
              </div>
              {memoQuery.isFetching && <p className="mt-4 text-sm text-slate-500" role="status">Loading memo…</p>}
              {memoQuery.isError && <p className="mt-4 text-sm text-rose-700" role="alert">{memoQuery.error.message}</p>}
              {memoQuery.data && (
                <div className="mt-4 flex flex-wrap items-center gap-3">
                  <Badge label={memoQuery.data.status} variant={memoStatusVariant(memoQuery.data.status)} />
                  <MemoActions caseId={caseId} memoId={memoQuery.data.id} status={memoQuery.data.status} />
                  <pre className="max-h-[480px] w-full overflow-auto whitespace-pre-wrap break-words rounded-lg border border-slate-200 bg-white p-4 text-xs leading-5 text-slate-700">{memoQuery.data.content == null ? "No memo content is available yet." : JSON.stringify(memoQuery.data.content, null, 2)}</pre>
                </div>
              )}
            </section>
          )}
          <p className="text-xs leading-5 text-slate-400">Memo content uses no-store API requests and remains in memory only for this active view.</p>
        </div>
      </section>
    </div>
  );
}

function InfoCell({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="bg-white px-5 py-4 md:px-6">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">{label}</p>
      <p className={`mt-2 truncate text-sm text-slate-800 ${mono ? "font-mono text-xs" : "font-medium"}`} title={value}>{value}</p>
    </div>
  );
}

function ConnectNotice() {
  return (
    <div className="grid min-h-72 place-items-center rounded-2xl border border-slate-200 bg-white px-6 text-center">
      <div className="max-w-md">
        <h1 className="text-xl font-semibold text-slate-900">Connect to view this case</h1>
        <p className="mt-2 text-sm leading-6 text-slate-500">Enter a Supabase access token and tenant UUID in the header first.</p>
      </div>
    </div>
  );
}
