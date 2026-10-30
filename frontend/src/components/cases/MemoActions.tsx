"use client";

import { useState, type FormEvent } from "react";
import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { useToast } from "@astryxdesign/core/Toast";
import { useApproveMemo, useCaseFacts } from "@/hooks/useCases";
import { ApiError, type CreditCase, type MemoVersion } from "@/lib/api/client";

function safeError(error: unknown) {
  if (error instanceof ApiError) return error.message;
  return "Memo approval failed. Check the current memo state before retrying.";
}

export function MemoActions({
  caseId,
  memoId,
  status,
}: {
  caseId: CreditCase["id"];
  memoId: MemoVersion["id"];
  status: MemoVersion["status"];
}) {
  const toast = useToast();
  const factsQuery = useCaseFacts(caseId);
  const approve = useApproveMemo(caseId, memoId);
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);
  const [conflictCount, setConflictCount] = useState(0);
  const [overrideReason, setOverrideReason] = useState("");
  const [localError, setLocalError] = useState("");

  async function beginApproval() {
    setLocalError("");
    try {
      // Re-read the current facts before prompting for an override reason.
      const result = await factsQuery.refetch();
      if (result.isError || !result.data) throw new Error("Fact state unavailable");
      // The contract exposes conflict status, but no criticality field. Conservatively require
      // a reason for every unresolved conflict rather than guessing which conflicts are critical.
      setConflictCount(result.data.filter((fact) => fact.reviewStatus === "conflict").length);
      setOverrideReason("");
      setIsConfirmOpen(true);
    } catch {
      const message = "Could not verify current fact conflicts. Refresh facts before approving this memo.";
      setLocalError(message);
      toast({ body: message, type: "error", uniqueID: `memo-facts-check-${memoId}` });
    }
  }

  async function confirmApproval(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (conflictCount > 0 && !overrideReason.trim()) {
      setLocalError("Enter an override reason after reviewing the unresolved conflict facts.");
      return;
    }
    setLocalError("");
    try {
      const reason = overrideReason.trim();
      await approve.mutateAsync(reason ? { override_reason: reason } : {});
      setIsConfirmOpen(false);
      setOverrideReason("");
      approve.reset();
      toast({ body: "Memo approved", uniqueID: `memo-approved-${memoId}` });
    } catch (error) {
      const message = safeError(error);
      setLocalError(message);
      toast({ body: message, type: "error", uniqueID: `memo-approve-error-${memoId}` });
      // Do not keep the override request body in the mutation cache after a failed attempt.
      approve.reset();
    }
  }

  const isApproved = status === "approved";
  const canApprove = status === "draft" && !approve.isPending;

  return (
    <div className="mt-4 flex flex-wrap items-center gap-3">
      {isApproved ? (
        <Badge label="Approved" variant="success" />
      ) : (
        <Button label="Approve memo" variant="primary" size="sm" onClick={() => void beginApproval()} isDisabled={!canApprove || factsQuery.isFetching} isLoading={factsQuery.isFetching || approve.isPending} />
      )}
      <Button label="Reject memo" variant="destructive" size="sm" isDisabled tooltip="No memo rejection operation is defined in openapi.json." />
      <p className="w-full text-xs leading-5 text-slate-500">Memo rejection is unavailable because the current OpenAPI contract defines no reject operation.</p>
      {localError && <p className="w-full text-sm text-rose-700" role="alert">{localError}</p>}

      {isConfirmOpen && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/45 p-4">
          <section role="dialog" aria-modal="true" aria-labelledby="approve-memo-title" className="w-full max-w-lg rounded-2xl bg-white p-5 shadow-2xl md:p-7">
            <h2 id="approve-memo-title" className="text-xl font-semibold text-slate-950">Approve this memo?</h2>
            <p className="mt-2 text-sm leading-6 text-slate-600">This records the memo approval and approval audit event.</p>
            {conflictCount > 0 && (
              <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm leading-6 text-amber-950">
                {conflictCount} fact{conflictCount === 1 ? " has" : "s have"} review status <code>conflict</code>. OpenAPI does not expose a criticality flag, so this UI requires an override reason for each unresolved conflict state.
              </div>
            )}
            {conflictCount === 0 && <p className="mt-3 text-xs leading-5 text-slate-500">No facts currently report conflict status. The API remains authoritative if an override reason is still required.</p>}
            <form onSubmit={confirmApproval}>
              <label className="mt-4 grid gap-2 text-sm font-medium text-slate-700">
                Override reason{conflictCount > 0 ? " (required)" : " (optional)"}
                <textarea
                  required={conflictCount > 0}
                  minLength={conflictCount > 0 ? 1 : undefined}
                  maxLength={1000}
                  value={overrideReason}
                  onChange={(event) => setOverrideReason(event.target.value)}
                  rows={3}
                  className="rounded-lg border border-slate-300 p-3 text-sm font-normal outline-none focus:border-emerald-700 focus:ring-2 focus:ring-emerald-100"
                  placeholder="Document the conflict review if needed"
                />
              </label>
              {localError && <p className="mt-3 text-sm text-rose-700" role="alert">{localError}</p>}
              <div className="mt-6 flex justify-end gap-2">
                <Button label="Cancel" variant="ghost" size="sm" onClick={() => setIsConfirmOpen(false)} isDisabled={approve.isPending} />
                <Button label="Confirm approval" variant="primary" size="sm" type="submit" isDisabled={approve.isPending || (conflictCount > 0 && !overrideReason.trim())} isLoading={approve.isPending} />
              </div>
            </form>
          </section>
        </div>
      )}
    </div>
  );
}
