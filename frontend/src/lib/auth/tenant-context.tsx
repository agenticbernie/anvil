"use client";

import { useAuth, useOrganization } from "@clerk/nextjs";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { exchangeClerkTokenForSupabaseToken } from "@/lib/supabase/client";
import { anvilApi, ApiError } from "@/lib/api/client";

export interface ApiCredentials {
  readonly tenantId: string;
  readonly sessionRevision: number;
  readonly getAccessToken: () => Promise<string | null>;
}

export type TenantAuthStatus = "loading" | "signed-out" | "tenant-required" | "mapping" | "exchanging" | "ready" | "error";

interface AuthTenantContextValue {
  readonly credentials: ApiCredentials | null;
  readonly status: TenantAuthStatus;
  readonly message: string | null;
  readonly tenantId: string | null;
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
const TENANT_REQUIRED_MESSAGE = "Select a Clerk organization to load its Anvil tenant.";
const TENANT_PROVISIONING_MESSAGE = "Đang đồng bộ tổ chức của bạn, vui lòng chờ vài giây hoặc refresh trang.";
const EXCHANGE_ERROR_MESSAGE = "Sign-in could not connect to Supabase. Check the custom OIDC provider settings.";
const MAPPING_ERROR_MESSAGE = "The organization could not be connected to Anvil. Try again later.";

export function AuthTenantProvider({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn, userId, sessionId, sessionClaims, orgId, getToken } = useAuth();
  const { isLoaded: organizationLoaded, organization } = useOrganization();
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
  const lastLoggedMappingError = useRef<string | null>(null);
  const currentScope = useRef<string | null>(null);
  const getClerkToken = useRef(getToken);
  getClerkToken.current = getToken;

  const claimTenantId = isLoaded && isSignedIn ? resolveTenantId(sessionClaims, orgId) : null;
  const organizationId = organization?.id ?? orgId ?? null;
  const developmentTenantId = process.env.NODE_ENV === "development"
    && isUuid(process.env.NEXT_PUBLIC_DEV_TENANT_ID)
    ? process.env.NEXT_PUBLIC_DEV_TENANT_ID
    : null;
  const scope = isLoaded && isSignedIn
    ? `${userId}:${sessionId}:${organizationId ?? "personal"}:${claimTenantId ?? "mapped-tenant"}`
    : null;
  currentScope.current = scope;

  const getAccessToken = useCallback(async (): Promise<string | null> => {
    if (!scope) return null;

    const cached = tokenCache.current;
    if (cached?.scope === scope && cached.expiresAt > Date.now() + 60_000) return cached.token;

    const existingFlight = exchangeFlight.current;
    if (existingFlight?.scope === scope) {
      const result = await existingFlight.promise;
      return currentScope.current === scope ? result.token : null;
    }

    const promise = (async (): Promise<CachedToken> => {
      const clerkToken = await getClerkToken.current({ template: 'supabase' });

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
  }, [scope]);

  const tenantMappingQuery = useQuery({
    queryKey: ["clerk-org-tenant", userId, sessionId, organizationId],
    queryFn: async ({ signal }) => {
      if (!organizationId) throw new Error("A Clerk organization must be selected.");
      const token = await getAccessToken();
      if (!token) throw new Error("Supabase access token is unavailable.");
      return anvilApi.TenantsController_getByClerkOrg(token, organizationId, signal);
    },
    enabled: Boolean(isLoaded && isSignedIn && organizationId && !claimTenantId && !developmentTenantId),
    staleTime: 5 * 60_000,
    gcTime: 10 * 60_000,
    refetchOnWindowFocus: false,
    retry: (failureCount, error) => error instanceof ApiError && error.status === 404
      ? failureCount < 3
      : failureCount < 1,
    retryDelay: (_attempt, error) => error instanceof ApiError && error.status === 404 ? 3_000 : 1_000,
  });

  const tenantId = claimTenantId ?? developmentTenantId ?? tenantMappingQuery.data?.tenant_id ?? null;

  const onTenantMappingError = useCallback((error: unknown) => {
    if (!organizationId) return;
    const errorStatus = error instanceof ApiError ? error.status : null;
    const errorMessage = error instanceof Error ? error.message : "Unknown tenant mapping error";
    const errorKey = `${scope}:${organizationId}:${errorStatus}:${errorMessage}`;
    if (lastLoggedMappingError.current === errorKey) return;
    lastLoggedMappingError.current = errorKey;
    console.error("Tenant organization mapping failed", { organizationId, userId, errorStatus, errorMessage });
  }, [organizationId, scope, userId]);

  // TanStack Query v5 removed useQuery's onError option; dispatch the equivalent
  // callback after configured retries are exhausted to avoid logging each retry.
  useEffect(() => {
    if (tenantMappingQuery.isError) {
      onTenantMappingError(tenantMappingQuery.error);
    } else {
      lastLoggedMappingError.current = null;
    }
  }, [onTenantMappingError, tenantMappingQuery.error, tenantMappingQuery.isError]);

  useEffect(() => {
    if (!isLoaded || (!organizationLoaded && !orgId && !developmentTenantId)) return;
    let active = true;

    if (lastScope.current !== scope) {
      queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== "clerk-org-tenant" });
      tokenCache.current = null;
      lastLoggedMappingError.current = null;
      lastScope.current = scope;
      setSessionRevision((revision) => revision + 1);
    }

    if (!isSignedIn) {
      setExchangeState({ scope: null, status: "signed-out", message: null });
      return () => { active = false; };
    }

    if (!claimTenantId && !developmentTenantId && !organizationId) {
      setExchangeState({ scope, status: "tenant-required", message: TENANT_REQUIRED_MESSAGE });
      return () => { active = false; };
    }

    if (!claimTenantId && !developmentTenantId && tenantMappingQuery.isPending) {
      setExchangeState({ scope, status: "mapping", message: null });
      return () => { active = false; };
    }

    if (!claimTenantId && !developmentTenantId && tenantMappingQuery.isError) {
      const notProvisioned = tenantMappingQuery.error instanceof ApiError && tenantMappingQuery.error.status === 404;
      setExchangeState({
        scope,
        status: notProvisioned ? "tenant-required" : "error",
        message: notProvisioned ? TENANT_PROVISIONING_MESSAGE : MAPPING_ERROR_MESSAGE,
      });
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
  }, [claimTenantId, developmentTenantId, getAccessToken, isLoaded, isSignedIn, orgId, organizationId, organizationLoaded, queryClient, scope, tenantId, tenantMappingQuery.error, tenantMappingQuery.isError, tenantMappingQuery.isPending]);

  const status: TenantAuthStatus = !isLoaded
    ? "loading"
    : !organizationLoaded && !orgId && !developmentTenantId
      ? "loading"
    : exchangeState.scope === scope
      ? exchangeState.status
      : !isSignedIn
        ? "signed-out"
        : tenantMappingQuery.isPending && organizationId && !claimTenantId && !developmentTenantId
          ? "mapping"
          : tenantId
          ? "exchanging"
          : "tenant-required";
  const message = status === "tenant-required"
    ? exchangeState.scope === scope && exchangeState.message
      ? exchangeState.message
      : TENANT_REQUIRED_MESSAGE
    : status === "error"
      ? exchangeState.scope === scope && exchangeState.message
        ? exchangeState.message
        : EXCHANGE_ERROR_MESSAGE
      : null;

  const credentials = useMemo<ApiCredentials | null>(() => {
    if (!isLoaded || !isSignedIn || !tenantId || status !== "ready") return null;
    return { tenantId, sessionRevision, getAccessToken };
  }, [getAccessToken, isLoaded, isSignedIn, sessionRevision, status, tenantId]);

  const value = useMemo<AuthTenantContextValue>(() => ({ credentials, status, message, tenantId }), [credentials, message, status, tenantId]);
  return <AuthTenantContext.Provider value={value}>{children}</AuthTenantContext.Provider>;
}

export function useAuthTenant(): AuthTenantContextValue {
  const context = useContext(AuthTenantContext);
  if (!context) throw new Error("useAuthTenant must be used inside AuthTenantProvider");
  return context;
}

export function useTenantId(): string | null {
  return useAuthTenant().tenantId;
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
