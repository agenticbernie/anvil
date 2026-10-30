"use client";

import { useEffect, useRef, useState } from "react";
import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { useToast } from "@astryxdesign/core/Toast";
import { useCaseFacts, useUpdateFact } from "@/hooks/useCases";
import { ApiError, type CaseFact, type CreditCase, type UpdateFactRequest } from "@/lib/api/client";
import { useAuthTenant } from "@/lib/auth/tenant-context";

type ReviewFilter = "all" | "verified" | "unverified" | "needs_evidence" | "conflict";

const reviewFilters: Array<{ value: ReviewFilter; label: string }> = [
  { value: "all", label: "All statuses" },
  { value: "verified", label: "Verified" },
  { value: "unverified", label: "Unverified" },
  { value: "needs_evidence", label: "Needs evidence" },
  { value: "conflict", label: "Conflict" },
];

const editableStatuses: CaseFact["reviewStatus"][] = ["verified", "unverified", "conflict", "needs_evidence", "rejected"];

function statusVariant(status: CaseFact["reviewStatus"]) {
  if (status === "verified") return "success" as const;
  if (status === "conflict" || status === "rejected") return "error" as const;
  if (status === "needs_evidence") return "warning" as const;
  return "neutral" as const;
}

function renderValue(value: CaseFact["rawValue"]) {
  if (value === null) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value === "object") return Object.values(value).every(isJsonValue);
  return false;
}

async function bodyFingerprint(factId: string, body: UpdateFactRequest) {
  const input = new TextEncoder().encode(JSON.stringify([factId, body]));
  const digest = await crypto.subtle.digest("SHA-256", input);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function FactReviewTable({ caseId }: { caseId: CreditCase["id"] }) {
  const { credentials } = useAuthTenant();
  const toast = useToast();
  const update = useUpdateFact(caseId);
  const attemptKeys = useRef(new Map<string, string>());
  const [filter, setFilter] = useState<ReviewFilter>("all");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [normalizedText, setNormalizedText] = useState("");
  const [editStatus, setEditStatus] = useState<CaseFact["reviewStatus"]>("unverified");
  const [formError, setFormError] = useState("");
  const query = useCaseFacts(caseId, filter === "all" ? undefined : filter);

  useEffect(() => {
    if (query.error) toast({ body: query.error.message, type: "error", uniqueID: "facts-read-error" });
  }, [query.error, toast]);
  useEffect(() => {
    attemptKeys.current.clear();
  }, [credentials?.sessionRevision]);

  const facts = query.data ?? [];

  function startEditing(fact: CaseFact) {
    update.reset();
    setEditingId(fact.id);
    setNormalizedText(JSON.stringify(fact.normalizedValue, null, 2));
    setEditStatus(fact.reviewStatus);
    setFormError("");
  }

  function cancelEditing() {
    setEditingId(null);
    setNormalizedText("");
    setFormError("");
    update.reset();
  }

  async function saveFact(factId: string) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(normalizedText) as unknown;
    } catch {
      setFormError("Enter a valid JSON value. Strings need quotes; use null to clear the value.");
      return;
    }
    if (!isJsonValue(parsed)) {
      setFormError("The value must be a JSON string, number, boolean, object, array, or null.");
      return;
    }

    // OpenAPI defines normalizedValue as a JSON oneOf; openapi-typescript narrows its object arm
    // to Record<string, never>, so the validated JSON value is asserted only at this boundary.
    const body: UpdateFactRequest = {
      normalizedValue: parsed as UpdateFactRequest["normalizedValue"],
      reviewStatus: editStatus,
    };
    try {
      const fingerprint = await bodyFingerprint(factId, body);
      const idempotencyKey = attemptKeys.current.get(fingerprint) ?? crypto.randomUUID();
      attemptKeys.current.set(fingerprint, idempotencyKey);

      await update.mutateAsync({ factId, body, idempotencyKey });
      attemptKeys.current.delete(fingerprint);
      update.reset();
      toast({ body: "Fact updated", uniqueID: `fact-updated-${factId}` });
      setEditingId(null);
      setNormalizedText("");
      setFormError("");
    } catch (error) {
      // Keep the body fingerprint and key for an unchanged retry, but clear mutation variables.
      const message = error instanceof ApiError
        ? error.message
        : "Fact update failed. Reconcile the current value before retrying.";
      setFormError(message);
      toast({ body: message, type: "error", uniqueID: `fact-update-error-${factId}` });
      update.reset();
    }
  }

  return (
    <section aria-labelledby="facts-heading">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 id="facts-heading" className="font-semibold text-slate-900">Extracted facts</h2>
          <p className="mt-1 text-sm leading-6 text-slate-500">Edit normalized values and review status. Source provenance remains unchanged.</p>
        </div>
        <label className="flex items-center gap-2 text-xs font-semibold text-slate-600">
          Review status
          <select
            value={filter}
            onChange={(event) => setFilter(event.target.value as ReviewFilter)}
            className="h-9 rounded-lg border border-slate-200 bg-white px-3 text-sm font-normal text-slate-800 outline-none focus:border-emerald-700 focus:ring-2 focus:ring-emerald-100"
          >
            {reviewFilters.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
      </div>

      {!credentials ? (
        <Message title="Connect an API session" body="Add a bearer token and tenant UUID in the header to load facts." />
      ) : query.isPending ? (
        <div className="grid min-h-48 place-items-center text-sm text-slate-500" role="status">Loading extracted facts…</div>
      ) : query.isError ? (
        <div className="mt-5 rounded-xl border border-rose-200 bg-rose-50 p-4" role="alert">
          <p className="text-sm font-medium text-rose-900">Could not load extracted facts</p>
          <p className="mt-1 text-sm text-rose-800">{query.error.message}</p>
          <Button label="Try again" variant="secondary" size="sm" onClick={() => void query.refetch()} className="mt-3" />
        </div>
      ) : facts.length === 0 ? (
        <Message title="No facts for this filter" body="Try another review status or check again after document processing." />
      ) : (
        <div className="mt-6 overflow-x-auto rounded-xl border border-slate-200">
          <table className="w-full min-w-[1050px] border-collapse text-left">
            <thead className="bg-slate-50 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-5 py-3">Field</th>
                <th className="px-4 py-3">Raw value</th>
                <th className="px-4 py-3">Normalized value</th>
                <th className="px-4 py-3">Confidence</th>
                <th className="px-4 py-3">Source</th>
                <th className="px-4 py-3">Review</th>
                <th className="px-5 py-3">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {facts.map((fact) => {
                const isEditing = editingId === fact.id;
                return (
                  <tr key={fact.id} className="align-top">
                    <td className="px-5 py-4 font-mono text-xs font-semibold text-slate-800">{fact.fieldName}</td>
                    <td className="max-w-64 whitespace-pre-wrap break-words px-4 py-4 text-sm text-slate-600">{renderValue(fact.rawValue)}</td>
                    <td className="max-w-72 px-4 py-4 text-sm text-slate-800">
                      {isEditing ? (
                        <textarea
                          rows={4}
                          aria-label={`Normalized value for ${fact.fieldName}`}
                          value={normalizedText}
                          onChange={(event) => { setNormalizedText(event.target.value); setFormError(""); }}
                          className="w-full min-w-60 rounded-lg border border-slate-300 p-2 font-mono text-xs leading-5 outline-none focus:border-emerald-700 focus:ring-2 focus:ring-emerald-100"
                        />
                      ) : <span className="whitespace-pre-wrap break-words">{renderValue(fact.normalizedValue)}</span>}
                    </td>
                    <td className="px-4 py-4"><Badge label={`${Math.round(fact.confidence * 100)}%`} variant="neutral" /></td>
                    <td className="whitespace-nowrap px-4 py-4 text-sm text-slate-600">Page {fact.sourcePage}</td>
                    <td className="px-4 py-4">
                      {isEditing ? (
                        <select
                          value={editStatus}
                          onChange={(event) => setEditStatus(event.target.value as CaseFact["reviewStatus"])}
                          aria-label={`Review status for ${fact.fieldName}`}
                          className="h-9 rounded-lg border border-slate-200 bg-white px-2 text-xs text-slate-800 outline-none focus:border-emerald-700"
                        >
                          {editableStatuses.map((status) => <option key={status} value={status}>{status.replaceAll("_", " ")}</option>)}
                        </select>
                      ) : <Badge label={fact.reviewStatus.replaceAll("_", " ")} variant={statusVariant(fact.reviewStatus)} />}
                    </td>
                    <td className="px-5 py-4">
                      {isEditing ? (
                        <div className="flex items-center gap-2">
                          <Button label="Save" variant="primary" size="sm" onClick={() => void saveFact(fact.id)} isDisabled={update.isPending} isLoading={update.isPending} />
                          <Button label="Cancel" variant="ghost" size="sm" onClick={cancelEditing} isDisabled={update.isPending} />
                        </div>
                      ) : (
                        <Button label="Edit" variant="secondary" size="sm" onClick={() => startEditing(fact)} isDisabled={update.isPending || Boolean(editingId)} />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {formError && <p className="mt-3 text-sm text-rose-700" role="alert">{formError}</p>}
      <p className="mt-4 text-xs text-slate-400">Fact values use no-store requests. Update retries reuse the same idempotency key when the fact and body are unchanged.</p>
    </section>
  );
}

function Message({ title, body }: { title: string; body: string }) {
  return (
    <div className="mt-6 grid min-h-44 place-items-center rounded-xl border border-dashed border-slate-200 bg-slate-50 px-5 text-center">
      <div><p className="text-sm font-medium text-slate-800">{title}</p><p className="mt-1 text-sm text-slate-500">{body}</p></div>
    </div>
  );
}
