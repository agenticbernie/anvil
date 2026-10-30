"use client";

import Link from "next/link";
import { OrganizationSwitcher, UserButton, useAuth } from "@clerk/nextjs";
import { useAuthTenant } from "@/lib/auth/tenant-context";

export function AccountMenu() {
  const { isLoaded, isSignedIn } = useAuth();
  const { credentials, status, message } = useAuthTenant();

  return (
    <div className="flex items-center justify-end gap-3">
      {isLoaded && isSignedIn && <OrganizationSwitcher hidePersonal />}
      <span
        className="hidden max-w-64 truncate text-xs text-slate-500 sm:inline"
        role={message ? "status" : undefined}
        title={message ?? (credentials ? `Tenant ${credentials.tenantId}` : undefined)}
      >
        {credentials
          ? `Tenant ${credentials.tenantId}`
          : status === "exchanging"
            ? "Connecting account…"
            : status === "tenant-required"
              ? "Tenant setup required"
              : status === "error"
                ? "API connection needs attention"
                : ""}
      </span>
      {isLoaded && isSignedIn ? <UserButton /> : <Link href="/sign-in" className="text-sm font-medium text-emerald-900">Sign in</Link>}
    </div>
  );
}
