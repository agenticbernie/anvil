"use client";

import { useState, type FormEvent } from "react";
import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { useAuthTenant } from "@/lib/auth/tenant-context";
import { useClearAnvilQueries } from "@/hooks/useCases";

export function SessionPanel() {
  const { credentials, connect, disconnect } = useAuthTenant();
  const clearQueries = useClearAnvilQueries();
  const [token, setToken] = useState("");
  const [tenant, setTenant] = useState("");
  const [isEditing, setIsEditing] = useState(!credentials);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token.trim() || !tenant.trim()) return;
    connect(token, tenant);
    setToken("");
    setIsEditing(false);
  }

  function signOut() {
    disconnect();
    clearQueries();
    setTenant("");
    setToken("");
    setIsEditing(true);
  }

  if (!isEditing && credentials) {
    return (
      <div className="flex flex-wrap items-center justify-end gap-3">
        <Badge variant="success" label="API connected" />
        <span className="max-w-48 truncate font-mono text-xs text-slate-500" title={credentials.tenantId}>
          Tenant {credentials.tenantId}
        </span>
        <Button label="Change session" variant="ghost" size="sm" onClick={() => setIsEditing(true)} />
        <Button label="Disconnect" variant="ghost" size="sm" onClick={signOut} />
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="grid w-full gap-3 rounded-xl border border-slate-200 bg-white p-4 md:grid-cols-[minmax(180px,1fr)_minmax(220px,1.25fr)_auto] md:items-end">
      <label className="grid gap-1.5 text-xs font-semibold text-slate-600">
        Tenant UUID
        <input
          required
          value={tenant}
          onChange={(event) => setTenant(event.target.value)}
          placeholder="Tenant UUID"
          className="h-10 rounded-lg border border-slate-200 bg-white px-3 font-normal text-slate-900 outline-none focus:border-emerald-700 focus:ring-2 focus:ring-emerald-100"
        />
      </label>
      <label className="grid gap-1.5 text-xs font-semibold text-slate-600">
        Supabase access token
        <input
          required
          type="password"
          autoComplete="off"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          placeholder="Paste access token (held in memory only)"
          className="h-10 rounded-lg border border-slate-200 bg-white px-3 font-normal text-slate-900 outline-none focus:border-emerald-700 focus:ring-2 focus:ring-emerald-100"
        />
      </label>
      <div className="flex items-center gap-3">
        <Button label="Connect" variant="primary" size="md" type="submit" />
        {credentials && <Button label="Cancel" variant="ghost" size="md" onClick={() => setIsEditing(false)} />}
      </div>
      <p className="text-xs leading-5 text-slate-500 md:col-span-3">
        MVP session input. A Supabase Auth integration can call the same in-memory <code>connect(accessToken, tenantId)</code> method.
      </p>
    </form>
  );
}
