BEGIN;

CREATE TABLE public.tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended', 'deleted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE public.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id uuid NOT NULL UNIQUE
    REFERENCES auth.users (id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE public.memberships (
  tenant_id uuid NOT NULL
    REFERENCES public.tenants (id) ON DELETE CASCADE,
  user_id uuid NOT NULL
    REFERENCES public.users (id) ON DELETE CASCADE,
  role text NOT NULL
    CHECK (role IN ('tenant_admin', 'originator', 'analyst', 'reviewer', 'auditor', 'viewer')),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  PRIMARY KEY (tenant_id, user_id)
);

CREATE INDEX memberships_user_status_tenant_idx
  ON public.memberships (user_id, status, tenant_id)
  WHERE deleted_at IS NULL;

-- SECURITY DEFINER avoids recursive RLS evaluation on memberships. The fixed,
-- empty search_path and schema-qualified relation names prevent object shadowing.
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
    JOIN public.users AS app_user
      ON app_user.id = membership.user_id
    JOIN public.tenants AS tenant
      ON tenant.id = membership.tenant_id
    WHERE membership.tenant_id = target_tenant_id
      AND app_user.auth_user_id = (SELECT auth.uid())
      AND app_user.status = 'active'
      AND app_user.deleted_at IS NULL
      AND membership.status = 'active'
      AND membership.deleted_at IS NULL
      AND tenant.status = 'active'
      AND tenant.deleted_at IS NULL
  );
$function$;

REVOKE ALL ON FUNCTION public.is_tenant_member(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_tenant_member(uuid) TO authenticated, service_role;

ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memberships ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenants_select_for_members
  ON public.tenants
  FOR SELECT
  TO authenticated
  USING (public.is_tenant_member(id));

CREATE POLICY users_select_self
  ON public.users
  FOR SELECT
  TO authenticated
  USING (auth_user_id = (SELECT auth.uid()));

CREATE POLICY memberships_select_for_tenant_members
  ON public.memberships
  FOR SELECT
  TO authenticated
  USING (
    public.is_tenant_member(tenant_id)
    AND status = 'active'
    AND deleted_at IS NULL
  );

-- Client roles receive read-only table privileges; onboarding and membership
-- changes must go through trusted server-side provisioning.
REVOKE ALL ON TABLE public.tenants, public.users, public.memberships FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.tenants, public.users, public.memberships
  FROM authenticated;
GRANT SELECT ON TABLE public.tenants, public.users, public.memberships TO authenticated;
GRANT ALL ON TABLE public.tenants, public.users, public.memberships TO service_role;

COMMENT ON FUNCTION public.is_tenant_member(uuid) IS
  'Returns true only for an authenticated user with an active membership in an active tenant.';

COMMIT;
