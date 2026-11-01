BEGIN;

-- auth.uid() remains the Supabase Auth UUID; memberships continue to reference
-- public.users.id. Resolve either the stored Auth UUID or its linked Clerk identity.
CREATE OR REPLACE FUNCTION public.has_tenant_role(target_tenant_id uuid, allowed_roles text[])
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
      AND membership.role = ANY (allowed_roles)
      AND membership.status = 'active' AND membership.deleted_at IS NULL
      AND app_user.status = 'active' AND app_user.deleted_at IS NULL
      AND tenant.status = 'active' AND tenant.deleted_at IS NULL
  );
$function$;

REVOKE ALL ON FUNCTION public.has_tenant_role(uuid, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.has_tenant_role(uuid, text[]) TO authenticated, anvil_backend, service_role;
GRANT EXECUTE ON FUNCTION public.is_tenant_member(uuid) TO anvil_backend;
GRANT USAGE ON SCHEMA auth TO anvil_backend;
GRANT EXECUTE ON FUNCTION auth.uid() TO anvil_backend;

COMMIT;
