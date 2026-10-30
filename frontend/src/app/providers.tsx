"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ClerkProvider } from "@clerk/nextjs";
import { useState, type ReactNode } from "react";
import { AuthTenantProvider } from "@/lib/auth/tenant-context";

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            refetchOnWindowFocus: false,
            retry: false,
          },
          mutations: { retry: false },
        },
      }),
  );

  return (
    <ClerkProvider signInUrl="/sign-in" signUpUrl="/sign-up">
      <QueryClientProvider client={queryClient}>
        <AuthTenantProvider>{children}</AuthTenantProvider>
      </QueryClientProvider>
    </ClerkProvider>
  );
}
