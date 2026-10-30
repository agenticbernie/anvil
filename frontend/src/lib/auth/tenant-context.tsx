"use client";

import { useAuth } from "@clerk/nextjs";
import { useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { exchangeClerkTokenForSupabaseToken } from "@/lib/supabase/client";

export interface ApiCredentials {
  readonly tenantId: string;
  readonly sessionRevision: number;
  readonly getAccessToken: () => Promise<string | null>;
}

export type TenantAuthStatus = "loading" | "signed-out" | "tenant-required" | "exchanging" | "ready" | "error";

interface AuthTenantContextValue {
  readonly credentials: ApiCredentials | null;
  readonly status: TenantAuthStatus;
  readonly message: string | null;
}

interface CachedToken {
  readonly scope: string;
  readonly token: string;
  readonly expiresAt: number;
}

interface TokenExchangeFlight {
  readonly scope: string;
  readonly promise: Promise<CachedToken>;
}

interface ExchangeState {
  readonly scope: string | null;
  readonly status: TenantAuthStatus;
  readonly message: string | null;
}

const AuthTenantContext = createContext<AuthTenantContextValue | null>(null);
const TENANT_REQUIRED_MESSAGE = "Set a UUID tenant_id claim in Clerk or select an organization mapped to a tenant UUID.";
const EXCHANGE_ERROR_MESSAGE = "Sign-in could not connect to Supabase. Check the custom OIDC provider settings.";

export function AuthTenantProvider({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn, userId, sessionId, sessionClaims, orgId, getToken } = useAuth();
  const queryClient = useQueryClient();
  const [sessionRevision, setSessionRevision] = useState(0);
  const [exchangeState, setExchangeState] = useState<ExchangeState>({
    scope: null,
    status: "loading",
    message: null,
  });
  const tokenCache = useRef<CachedToken | null>(null);
  const exchangeFlight = useRef<TokenExchangeFlight | null>(null);
  const lastScope = useRef<string | null>(null);
  const currentScope = useRef<string | null>(null);
  const getClerkToken = useRef(getToken);
  getClerkToken.current = getToken;

  const tenantId = isLoaded && isSignedIn ? resolveTenantId(sessionClaims, orgId) : null;
  const scope = isLoaded && isSignedIn
    ? `${userId}:${sessionId}:${orgId ?? "personal"}:${tenantId ?? "missing-tenant"}`
    : null;
  currentScope.current = scope;

  const getAccessToken = useCallback(async (): Promise<string | null> => {
    if (!scope || !tenantId) return null;

    const cached = tokenCache.current;
    if (cached?.scope === scope && cached.expiresAt > Date.now() + 60_000) return cached.token;

    const existingFlight = exchangeFlight.current;
    if (existingFlight?.scope === scope) {
      const result = await existingFlight.promise;
      return currentScope.current === scope ? result.token : null;
    }

    const promise = (async (): Promise<CachedToken> => {
      const clerkToken = await getClerkToken.current();
      if (!clerkToken) throw new Error("Clerk session token is unavailable.");
      const exchanged = await exchangeClerkTokenForSupabaseToken(clerkToken);
      return { scope, token: exchanged.token, expiresAt: exchanged.expiresAt };
    })();
    exchangeFlight.current = { scope, promise };

    try {
      const result = await promise;
      if (currentScope.current !== scope) return null;
      tokenCache.current = result;
      return result.token;
    } finally {
      if (exchangeFlight.current?.promise === promise) exchangeFlight.current = null;
    }
  }, [scope, tenantId]);

  useEffect(() => {
    if (!isLoaded) return;
    let active = true;

    if (lastScope.current !== scope) {
      queryClient.clear();
      tokenCache.current = null;
      lastScope.current = scope;
      setSessionRevision((revision) => revision + 1);
    }

    if (!isSignedIn) {
      setExchangeState({ scope: null, status: "signed-out", message: null });
      return () => { active = false; };
    }

    if (!tenantId) {
      setExchangeState({ scope, status: "tenant-required", message: TENANT_REQUIRED_MESSAGE });
      return () => { active = false; };
    }

    setExchangeState({ scope, status: "exchanging", message: null });
    void getAccessToken()
      .then((token) => {
        if (!active) return;
        if (!token) throw new Error("Supabase access token is unavailable.");
        setExchangeState({ scope, status: "ready", message: null });
      })
      .catch(() => {
        if (active) setExchangeState({ scope, status: "error", message: EXCHANGE_ERROR_MESSAGE });
      });

    return () => { active = false; };
  }, [getAccessToken, isLoaded, isSignedIn, queryClient, scope, tenantId]);

  const status: TenantAuthStatus = !isLoaded
    ? "loading"
    : exchangeState.scope === scope
      ? exchangeState.status
      : !isSignedIn
        ? "signed-out"
        : tenantId
          ? "exchanging"
          : "tenant-required";
  const message = status === "tenant-required"
    ? TENANT_REQUIRED_MESSAGE
    : status === "error"
      ? EXCHANGE_ERROR_MESSAGE
      : null;

  const credentials = useMemo<ApiCredentials | null>(() => {
    if (!isLoaded || !isSignedIn || !tenantId || status !== "ready") return null;
    return { tenantId, sessionRevision, getAccessToken };
  }, [getAccessToken, isLoaded, isSignedIn, sessionRevision, status, tenantId]);

  const value = useMemo<AuthTenantContextValue>(() => ({ credentials, status, message }), [credentials, message, status]);
  return <AuthTenantContext.Provider value={value}>{children}</AuthTenantContext.Provider>;
}

export function useAuthTenant(): AuthTenantContextValue {
  const context = useContext(AuthTenantContext);
  if (!context) throw new Error("useAuthTenant must be used inside AuthTenantProvider");
  return context;
}

function resolveTenantId(sessionClaims: unknown, organizationId: string | null): string | null {
  const claims = asRecord(sessionClaims);
  const appMetadata = asRecord(claims?.app_metadata);
  const publicMetadata = asRecord(claims?.public_metadata);
  const organization = asRecord(claims?.o);
  const candidates = [
    claims?.tenant_id,
    appMetadata?.tenant_id,
    publicMetadata?.tenant_id,
    claims?.org_id,
    organization?.id,
    organizationId,
  ];
  return candidates.find(isUuid) ?? null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isUuid(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
