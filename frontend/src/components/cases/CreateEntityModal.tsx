"use client";

import { useState, type FormEvent } from "react";
import { Button } from "@astryxdesign/core/Button";
import { useToast } from "@astryxdesign/core/Toast";
import { useCreateEntity } from "@/hooks/useCases";
import { ApiError, type CreatedEntity } from "@/lib/api/client";
import { useAuthTenant } from "@/lib/auth/tenant-context";

function safeError(error: unknown) {
  if (error instanceof ApiError) return error.message;
  return "Entity creation failed. Check the entity details and try again.";
}

export function CreateEntityModal({
  isOpen,
  onOpenChange,
  onCreated,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (entity: CreatedEntity) => void;
}) {
  const { credentials } = useAuthTenant();
  const createEntity = useCreateEntity();
  const toast = useToast();
  const [name, setName] = useState("");
  const [type, setType] = useState<"individual" | "business">("individual");
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedName = name.trim();
    if (!normalizedName || normalizedName.length > 100) {
      setError("Enter an entity name between 1 and 100 characters.");
      return;
    }
    setError("");
    try {
      const entity = await createEntity.mutateAsync({ name: normalizedName, type });
      setName("");
      setType("individual");
      createEntity.reset();
      onOpenChange(false);
      toast({ body: "Entity created successfully", uniqueID: "entity-created" });
      onCreated(entity);
    } catch (cause) {
      const message = safeError(cause);
      setError(message);
      toast({ body: message, type: "error", uniqueID: "entity-create-error" });
    }
  }

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/45 p-4">
      <section role="dialog" aria-modal="true" aria-labelledby="create-entity-title" className="w-full max-w-lg rounded-2xl bg-white p-5 shadow-2xl md:p-7">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="eyebrow text-[10px] font-semibold text-emerald-800">Organization records</p>
            <h2 id="create-entity-title" className="mt-2 text-xl font-semibold text-slate-950">Create a new entity</h2>
          </div>
          <button type="button" aria-label="Close create entity dialog" onClick={() => onOpenChange(false)} disabled={createEntity.isPending} className="rounded-md px-2 py-1 text-xl text-slate-400 hover:bg-slate-100 disabled:opacity-40">×</button>
        </div>
        <p className="mt-3 text-sm leading-6 text-slate-600">Entity names are encrypted before they are stored. The new entity ID will be added to your case form.</p>
        <form onSubmit={submit} className="mt-5 space-y-4">
          <label className="grid gap-2 text-sm font-medium text-slate-700">
            Entity Name
            <input
              required
              maxLength={100}
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoComplete="organization"
              className="rounded-lg border border-slate-300 px-3 py-2.5 text-sm outline-none focus:border-emerald-700 focus:ring-2 focus:ring-emerald-100"
            />
          </label>
          <label className="grid gap-2 text-sm font-medium text-slate-700">
            Entity Type
            <select
              value={type}
              onChange={(event) => setType(event.target.value as "individual" | "business")}
              className="rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm outline-none focus:border-emerald-700 focus:ring-2 focus:ring-emerald-100"
            >
              <option value="individual">Individual</option>
              <option value="business">Business</option>
            </select>
          </label>
          {error && <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800" role="alert">{error}</p>}
          <div className="flex justify-end gap-2 pt-2">
            <Button label="Cancel" variant="ghost" size="sm" onClick={() => onOpenChange(false)} isDisabled={createEntity.isPending} />
            <Button label="Create" variant="primary" size="sm" type="submit" isDisabled={!credentials || createEntity.isPending} isLoading={createEntity.isPending} />
          </div>
        </form>
      </section>
    </div>
  );
}
