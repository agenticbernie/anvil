import { createClient } from "@supabase/supabase-js";

interface SupabaseAccessToken {
  readonly token: string;
  readonly expiresAt: number;
}

export async function exchangeClerkTokenForSupabaseToken(clerkToken: string): Promise<SupabaseAccessToken> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
    ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !publishableKey) {
    throw new Error("Supabase browser configuration is missing.");
  }

  const supabase = createClient(supabaseUrl, publishableKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
  const { data, error } = await supabase.auth.signInWithIdToken({
    provider: "custom:clerk",
    token: clerkToken,
  });

  if (error) throw new Error("Clerk token exchange with Supabase failed.", { cause: error });
  if (!data.session) throw new Error("Supabase did not return an authenticated session.");

  const expiresAt = data.session.expires_at
    ? data.session.expires_at * 1_000
    : Date.now() + data.session.expires_in * 1_000;

  return { token: data.session.access_token, expiresAt };
}
