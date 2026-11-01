"use client";

import { useRef, useState, type FormEvent } from "react";
import { Button } from "@astryxdesign/core/Button";
import { useToast } from "@astryxdesign/core/Toast";
import { useCreateCase } from "@/hooks/useCases";
import { ApiError } from "@/lib/api/client";
import { useAuthTenant, useTenantId } from "@/lib/auth/tenant-context";

function safeError(error: unknown) {
  if (error instanceof ApiError) return error.message;
  return "Case creation failed. Check the values and current tenant, then retry.";
}

export function CreateCaseModal({ onCreated }: { onCreated: () => void }) {
  const { credentials } = useAuthTenant();
  const tenantId = useTenantId();
  const createCase = useCreateCase();
  const toast = useToast();
  const [isOpen, setIsOpen] = useState(false);
  const [entityId, setEntityId] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [error, setError] = useState("");
  // Reuse the key for an identical retry; a changed payload is a new user intent.
  const idempotency = useRef<{ fingerprint: string; key: string } | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!credentials || !tenantId || credentials.tenantId !== tenantId) {
      setError("Connect an organization with an active tenant before creating a case.");
      return;
    }

    const body = { entityId: entityId.trim(), currency: currency.trim() };
    const fingerprint = JSON.stringify(body);
    if (!idempotency.current || idempotency.current.fingerprint !== fingerprint) {
      idempotency.current = { fingerprint, key: crypto.randomUUID() };
    }

    setError("");
    try {
      await createCase.mutateAsync({ body, idempotencyKey: idempotency.current.key });
      idempotency.current = null;
      createCase.reset();
      setEntityId("");
      setCurrency("USD");
      setIsOpen(false);
      onCreated();
      toast({ body: "Draft case created", uniqueID: "case-created" });
    } catch (cause) {
      const message = safeError(cause);
      setError(message);
      toast({ body: message, type: "error", uniqueID: "case-create-error" });
    }
  }

  return (
    <>
      <Button label="Create Case" variant="primary" size="sm" onClick={() => setIsOpen(true)} isDisabled={!credentials} />
      {isOpen && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/45 p-4">
          <section role="dialog" aria-modal="true" aria-labelledby="create-case-title" className="w-full max-w-lg rounded-2xl bg-white p-5 shadow-2xl md:p-7">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="eyebrow text-[10px] font-semibold text-emerald-800">New underwriting work</p>
                <h2 id="create-case-title" className="mt-2 text-xl font-semibold text-slate-950">Create a credit case</h2>
              </div>
              <button type="button" aria-label="Close create case dialog" onClick={() => setIsOpen(false)} disabled={createCase.isPending} className="rounded-md px-2 py-1 text-xl text-slate-400 hover:bg-slate-100 disabled:opacity-40">×</button>
            </div>
            <p className="mt-3 text-sm leading-6 text-slate-600">The API creates new cases as drafts. Provide an existing entity and a three-character currency code.</p>
            <form onSubmit={submit} className="mt-5 space-y-4">
              <label className="grid gap-2 text-sm font-medium text-slate-700">
                Entity ID
                <input
                  required
                  pattern="[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
                  title="Enter an entity UUID."
                  value={entityId}
                  onChange={(event) => setEntityId(event.target.value)}
                  placeholder="00000000-0000-4000-8000-000000000031"
                  className="rounded-lg border border-slate-300 px-3 py-2.5 font-mono text-sm outline-none focus:border-emerald-700 focus:ring-2 focus:ring-emerald-100"
                />
              </label>
              <label className="grid gap-2 text-sm font-medium text-slate-700">
                Currency
                <input
                  required
                  minLength={3}
                  maxLength={3}
                  value={currency}
                  onChange={(event) => setCurrency(event.target.value)}
                  placeholder="USD"
                  className="rounded-lg border border-slate-300 px-3 py-2.5 text-sm uppercase outline-none focus:border-emerald-700 focus:ring-2 focus:ring-emerald-100"
                />
              </label>
              {error && <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800" role="alert">{error}</p>}
              <div className="flex justify-end gap-2 pt-2">
                <Button label="Cancel" variant="ghost" size="sm" onClick={() => setIsOpen(false)} isDisabled={createCase.isPending} />
                <Button label="Create draft" variant="primary" size="sm" type="submit" isDisabled={createCase.isPending || !tenantId} isLoading={createCase.isPending} />
              </div>
            </form>
          </section>
        </div>
      )}
    </>
  );
}
