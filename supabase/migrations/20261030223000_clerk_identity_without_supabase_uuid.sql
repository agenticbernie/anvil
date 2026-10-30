BEGIN;

-- Clerk identities may be provisioned before Supabase Auth creates its UUID.
ALTER TABLE public.users
  ALTER COLUMN auth_user_id DROP NOT NULL;

ALTER TABLE public.users
  ADD CONSTRAINT users_require_auth_or_clerk_identity
  CHECK (auth_user_id IS NOT NULL OR clerk_user_id IS NOT NULL);

ALTER TABLE public.tenants
  ADD COLUMN provisioned_by_clerk_organization_id text UNIQUE;

CREATE OR REPLACE FUNCTION public.is_current_clerk_user(target_clerk_user_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM auth.identities AS identity
    WHERE identity.user_id = (SELECT auth.uid())
      AND identity.provider_id = target_clerk_user_id
      AND identity.provider IN ('custom:clerk', 'clerk')
  );
$function$;

REVOKE ALL ON FUNCTION public.is_current_clerk_user(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_current_clerk_user(text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.is_tenant_member(target_tenant_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.memberships AS membership
    JOIN public.users AS app_user ON app_user.id = membership.user_id
    JOIN public.tenants AS tenant ON tenant.id = membership.tenant_id
    WHERE membership.tenant_id = target_tenant_id
      AND (app_user.auth_user_id = (SELECT auth.uid())
        OR public.is_current_clerk_user(app_user.clerk_user_id))
      AND app_user.status = 'active' AND app_user.deleted_at IS NULL
      AND membership.status = 'active' AND membership.deleted_at IS NULL
      AND tenant.status = 'active' AND tenant.deleted_at IS NULL
  );
$function$;

REVOKE ALL ON FUNCTION public.is_tenant_member(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_tenant_member(uuid) TO authenticated, service_role;

DROP POLICY IF EXISTS users_select_self ON public.users;
CREATE POLICY users_select_self ON public.users FOR SELECT TO authenticated
  USING (auth_user_id = (SELECT auth.uid()) OR public.is_current_clerk_user(clerk_user_id));

COMMIT;
