"use client";

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

export interface ApiCredentials {
  authToken: string;
  tenantId: string;
  /** Changes on connect/disconnect so cached data from an old in-memory session is not reused. */
  sessionRevision: number;
}

interface AuthTenantContextValue {
  credentials: ApiCredentials | null;
  connect: (authToken: string, tenantId: string) => void;
  disconnect: () => void;
}

const AuthTenantContext = createContext<AuthTenantContextValue | null>(null);

export function AuthTenantProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Omit<ApiCredentials, "sessionRevision"> | null>(null);
  const [sessionRevision, setSessionRevision] = useState(0);

  const value = useMemo<AuthTenantContextValue>(
    () => ({
      credentials: session ? { ...session, sessionRevision } : null,
      connect: (authToken, tenantId) => {
        // Tokens stay in component memory; never write them to localStorage, logs, or URLs.
        setSession({ authToken: authToken.trim(), tenantId: tenantId.trim() });
        setSessionRevision((revision) => revision + 1);
      },
      disconnect: () => {
        setSession(null);
        setSessionRevision((revision) => revision + 1);
      },
    }),
    [session, sessionRevision],
  );

  return <AuthTenantContext.Provider value={value}>{children}</AuthTenantContext.Provider>;
}

export function useAuthTenant() {
  const context = useContext(AuthTenantContext);
  if (!context) throw new Error("useAuthTenant must be used inside AuthTenantProvider");
  return context;
}
