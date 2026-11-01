"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { useToast } from "@astryxdesign/core/Toast";
import { useCases } from "@/hooks/useCases";
import { CreateCaseModal } from "@/components/cases/CreateCaseModal";
import { ApiError, type CreditCase } from "@/lib/api/client";
import { useAuthTenant } from "@/lib/auth/tenant-context";

const pageSize = 20; // Matches the OpenAPI list default and stays within its documented 1–100 range.

function statusVariant(status: CreditCase["status"]) {
  if (status === "approved") return "success" as const;
  if (status === "rejected" || status === "archived") return "neutral" as const;
  if (status === "processing" || status === "in_review") return "info" as const;
  return "warning" as const;
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? value
    : new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export default function CasesPage() {
  const { credentials, status: authStatus, message: authMessage } = useAuthTenant();
  const toast = useToast();
  const [cursorStack, setCursorStack] = useState<Array<string | undefined>>([undefined]);
  const cursor = cursorStack[cursorStack.length - 1];
  const query = useCases({ limit: pageSize, ...(cursor ? { cursor } : {}) });

  useEffect(() => {
    if (!query.error) return;
    toast({ body: query.error.message, type: "error", uniqueID: "cases-list-error" });
  }, [query.error, toast]);

  const nextCursor = query.data?.nextCursor ?? undefined;

  const rows: CreditCase[] = query.data?.items ?? [];
  const canContinue = Boolean(nextCursor);

  function goNext() {
    if (!nextCursor) return;
    setCursorStack((stack) => [...stack, nextCursor]);
  }

  function goPrevious() {
    setCursorStack((stack) => (stack.length > 1 ? stack.slice(0, -1) : stack));
  }

  return (
    <div className="space-y-7">
      <section className="flex flex-col justify-between gap-5 md:flex-row md:items-end">
        <div>
          <p className="eyebrow text-[10px] font-semibold text-emerald-800">Underwriting workspace</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950 md:text-[34px]">Credit cases</h1>
          <p className="mt-2 max-w-xl text-sm leading-6 text-slate-500">Review your tenant’s active and historical credit work in one place.</p>
        </div>
        <div className="flex items-center gap-3 text-sm text-slate-500">
          <span className="size-2 rounded-full bg-emerald-600" />
          {credentials ? "Live tenant data" : ["loading", "mapping", "exchanging"].includes(authStatus) ? "Connecting organization" : "Tenant setup required"}
        </div>
      </section>

      <section className="surface-shadow overflow-hidden rounded-2xl border border-slate-200 bg-white">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-100 px-5 py-4 md:px-7">
          <div>
            <h2 className="font-semibold text-slate-900">All cases</h2>
            <p className="mt-1 text-xs text-slate-500">Sorted by the API’s cursor order</p>
          </div>
          <div className="flex items-center gap-3">
            {query.isFetching && <span className="text-xs text-slate-500">Refreshing…</span>}
            <Button label="Refresh" variant="secondary" size="sm" onClick={() => void query.refetch()} isDisabled={!credentials || query.isFetching} />
            <CreateCaseModal onCreated={() => setCursorStack([undefined])} />
          </div>
        </div>

        {!credentials && ["loading", "mapping", "exchanging"].includes(authStatus) ? (
          <div className="grid min-h-64 place-items-center px-6 py-14 text-center" role="status" aria-live="polite">
            <div>
              <div className="mx-auto size-8 animate-spin rounded-full border-2 border-emerald-700 border-t-transparent" aria-hidden="true" />
              <p className="mt-4 text-sm text-slate-600">
                {authStatus === "mapping" ? "Connecting this organization to its tenant…" : "Preparing your workspace…"}
              </p>
            </div>
          </div>
        ) : !credentials ? (
          <div className="grid min-h-64 place-items-center px-6 py-14 text-center">
            <div className="max-w-md">
              <div className="mx-auto grid size-12 place-items-center rounded-2xl bg-emerald-50 text-lg font-semibold text-emerald-900">A</div>
              <h3 className="mt-4 font-semibold text-slate-900">Tenant setup required</h3>
              <p className="mt-2 text-sm leading-6 text-slate-500">{authMessage ?? "Select an organization that has been provisioned for Anvil."}</p>
            </div>
          </div>
        ) : query.isPending ? (
          <div className="grid min-h-64 place-items-center text-sm text-slate-500" role="status">Loading cases…</div>
        ) : query.isError ? (
          <div className="m-6 rounded-xl border border-rose-200 bg-rose-50 px-5 py-4" role="alert">
            <p className="font-medium text-rose-900">Could not load cases</p>
            <p className="mt-1 text-sm text-rose-800">{query.error instanceof ApiError ? query.error.message : "Check the API URL and connection, then retry."}</p>
            <Button label="Try again" variant="secondary" size="sm" onClick={() => void query.refetch()} className="mt-4" />
          </div>
        ) : rows.length === 0 ? (
          <div className="grid min-h-64 place-items-center px-6 py-14 text-center">
            <div>
              <p className="font-medium text-slate-900">No cases yet</p>
              <p className="mt-2 text-sm text-slate-500">The API returned an empty page for this tenant.</p>
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] border-collapse text-left">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50/70 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                  <th className="px-7 py-3.5">Case number</th>
                  <th className="px-5 py-3.5">Status</th>
                  <th className="px-5 py-3.5">Entity ID</th>
                  <th className="px-5 py-3.5">Created</th>
                  <th className="px-7 py-3.5 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((item) => (
                  <tr key={item.id} className="transition-colors hover:bg-slate-50/70">
                    <td className="px-7 py-4">
                      <Link href={`/cases/${item.id}`} className="font-semibold text-slate-900 underline-offset-4 hover:text-emerald-800 hover:underline">{item.caseNumber}</Link>
                      <p className="mt-1 font-mono text-[10px] text-slate-400">{item.id}</p>
                    </td>
                    <td className="px-5 py-4"><Badge label={item.status.replaceAll("_", " ")} variant={statusVariant(item.status)} /></td>
                    <td className="max-w-56 truncate px-5 py-4 font-mono text-xs text-slate-600" title={item.entityId}>{item.entityId}</td>
                    <td className="whitespace-nowrap px-5 py-4 text-sm text-slate-600">{formatDate(item.createdAt)}</td>
                    <td className="px-7 py-4 text-right">
                      <Link href={`/cases/${item.id}`} className="text-xs font-semibold text-emerald-800 underline-offset-4 hover:underline">View details <span aria-hidden="true">↗</span></Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {credentials && !query.isError && !query.isPending && rows.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 px-5 py-4 md:px-7">
            <p className="text-xs text-slate-500">Showing {rows.length} case{rows.length === 1 ? "" : "s"}</p>
            <div className="flex gap-2">
              <Button label="Previous" variant="secondary" size="sm" onClick={goPrevious} isDisabled={cursorStack.length <= 1 || query.isFetching} />
              <Button label="Next page" variant="secondary" size="sm" onClick={goNext} isDisabled={!canContinue || query.isFetching} />
            </div>
          </div>
        )}
      </section>
      <p className="text-xs leading-5 text-slate-400">Entity is shown by ID because the OpenAPI contract has no entity lookup operation or entity name in the case response.</p>
    </div>
  );
}
