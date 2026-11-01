BEGIN;

-- The signed Clerk webhook is the only application flow that needs this lookup.
-- It runs as the backend role; public clients cannot enumerate Auth identities.
CREATE OR REPLACE FUNCTION public.clerk_supabase_user_id(target_clerk_user_id text)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT identity.user_id
  FROM auth.identities AS identity
  WHERE identity.provider_id = target_clerk_user_id
    AND identity.provider IN ('custom:clerk', 'clerk')
  LIMIT 1;
$function$;

REVOKE ALL ON FUNCTION public.clerk_supabase_user_id(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.clerk_supabase_user_id(text) TO anvil_backend, service_role;

-- Existing RLS policies still use auth.uid(); preserve their required privileges.
GRANT USAGE ON SCHEMA auth TO anvil_backend;
GRANT EXECUTE ON FUNCTION auth.uid() TO anvil_backend;

COMMIT;
