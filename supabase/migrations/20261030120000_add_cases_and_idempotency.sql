BEGIN;

DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'anvil_backend') THEN
    EXECUTE 'CREATE ROLE anvil_backend NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS';
  END IF;
END;
$role$;
GRANT USAGE ON SCHEMA auth TO anvil_backend;
GRANT EXECUTE ON FUNCTION public.is_tenant_member(uuid) TO anvil_backend;
GRANT EXECUTE ON FUNCTION auth.uid() TO anvil_backend;

CREATE TABLE public.credit_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,
  entity_id uuid NOT NULL,
  case_number text NOT NULL CHECK (char_length(case_number) BETWEEN 1 AND 80),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'documents_pending', 'processing', 'memo_ready', 'in_review', 'approved', 'rejected', 'archived')),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT credit_cases_tenant_case_number_unique UNIQUE (tenant_id, case_number)
);

CREATE INDEX credit_cases_tenant_created_idx
  ON public.credit_cases (tenant_id, created_at DESC, id DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX credit_cases_tenant_status_created_idx
  ON public.credit_cases (tenant_id, status, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE TABLE public.idempotency_keys (
  tenant_id uuid NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,
  actor_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 128),
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  response_status smallint CHECK (response_status BETWEEN 100 AND 599),
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, actor_id, idempotency_key),
  CHECK (expires_at > created_at)
);
CREATE INDEX idempotency_keys_expiry_idx ON public.idempotency_keys (expires_at);

CREATE TABLE public.audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,
  actor_id uuid NOT NULL REFERENCES auth.users (id),
  event_type text NOT NULL CHECK (char_length(event_type) BETWEEN 1 AND 120),
  resource_type text NOT NULL CHECK (char_length(resource_type) BETWEEN 1 AND 80),
  resource_id uuid NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_tenant_created_idx
  ON public.audit_events (tenant_id, created_at DESC, id DESC);

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
      AND app_user.auth_user_id = (SELECT auth.uid())
      AND membership.role = ANY (allowed_roles)
      AND membership.status = 'active' AND membership.deleted_at IS NULL
      AND app_user.status = 'active' AND app_user.deleted_at IS NULL
      AND tenant.status = 'active' AND tenant.deleted_at IS NULL
  );
$function$;
REVOKE ALL ON FUNCTION public.has_tenant_role(uuid, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.has_tenant_role(uuid, text[]) TO authenticated, anvil_backend, service_role;

CREATE OR REPLACE FUNCTION public.guard_credit_case_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.entity_id IS DISTINCT FROM OLD.entity_id
    OR NEW.case_number IS DISTINCT FROM OLD.case_number
    OR NEW.currency IS DISTINCT FROM OLD.currency
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Immutable credit case fields cannot be changed.';
  END IF;

  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'Credit case version must increase by one.';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
      (OLD.status = 'draft' AND NEW.status = 'documents_pending') OR
      (OLD.status = 'documents_pending' AND NEW.status = 'processing') OR
      (OLD.status = 'processing' AND NEW.status = 'memo_ready') OR
      (OLD.status = 'memo_ready' AND NEW.status = 'in_review') OR
      (OLD.status = 'in_review' AND NEW.status IN ('approved', 'rejected')) OR
      (NEW.status = 'archived' AND NEW.deleted_at IS NOT NULL)
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Invalid credit case status transition.';
    END IF;
  END IF;

  IF NEW.status IN ('approved', 'rejected')
    AND NOT public.has_tenant_role(NEW.tenant_id, ARRAY['tenant_admin', 'reviewer']) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Only a tenant admin or reviewer may finalize a credit case.';
  END IF;

  IF NEW.status = 'archived'
    AND NOT public.has_tenant_role(NEW.tenant_id, ARRAY['tenant_admin', 'originator']) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Only a tenant admin or originator may archive a credit case.';
  END IF;

  IF (NEW.deleted_at IS NULL) <> (NEW.status <> 'archived') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Archived status and deleted_at must be set together.';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER credit_cases_guard_update
  BEFORE UPDATE ON public.credit_cases
  FOR EACH ROW EXECUTE FUNCTION public.guard_credit_case_update();

ALTER TABLE public.credit_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.credit_cases FORCE ROW LEVEL SECURITY;
ALTER TABLE public.idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.idempotency_keys FORCE ROW LEVEL SECURITY;
ALTER TABLE public.audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_events FORCE ROW LEVEL SECURITY;

CREATE POLICY credit_cases_select_for_members
  ON public.credit_cases FOR SELECT TO authenticated, anvil_backend
  USING (
    public.is_tenant_member(tenant_id)
    AND public.has_tenant_role(tenant_id, ARRAY['tenant_admin', 'originator', 'analyst', 'reviewer', 'auditor'])
  );
CREATE POLICY credit_cases_insert_for_members
  ON public.credit_cases FOR INSERT TO anvil_backend
  WITH CHECK (
    public.is_tenant_member(tenant_id)
    AND public.has_tenant_role(tenant_id, ARRAY['tenant_admin', 'originator'])
    AND status = 'draft' AND version = 1 AND deleted_at IS NULL
  );
CREATE POLICY credit_cases_update_for_members
  ON public.credit_cases FOR UPDATE TO anvil_backend
  USING (
    public.is_tenant_member(tenant_id)
    AND public.has_tenant_role(tenant_id, ARRAY['tenant_admin', 'originator', 'analyst', 'reviewer'])
  )
  WITH CHECK (
    public.is_tenant_member(tenant_id)
    AND public.has_tenant_role(tenant_id, ARRAY['tenant_admin', 'originator', 'analyst', 'reviewer'])
    AND (status NOT IN ('approved', 'rejected') OR public.has_tenant_role(tenant_id, ARRAY['tenant_admin', 'reviewer']))
    AND (status <> 'archived' OR public.has_tenant_role(tenant_id, ARRAY['tenant_admin', 'originator']))
  );

CREATE POLICY idempotency_select_for_actor
  ON public.idempotency_keys FOR SELECT TO anvil_backend
  USING (actor_id = (SELECT auth.uid()) AND public.is_tenant_member(tenant_id));
CREATE POLICY idempotency_insert_for_actor
  ON public.idempotency_keys FOR INSERT TO anvil_backend
  WITH CHECK (actor_id = (SELECT auth.uid()) AND public.is_tenant_member(tenant_id));
CREATE POLICY idempotency_update_for_actor
  ON public.idempotency_keys FOR UPDATE TO anvil_backend
  USING (actor_id = (SELECT auth.uid()) AND public.is_tenant_member(tenant_id))
  WITH CHECK (actor_id = (SELECT auth.uid()) AND public.is_tenant_member(tenant_id));
CREATE POLICY idempotency_delete_for_actor
  ON public.idempotency_keys FOR DELETE TO anvil_backend
  USING (actor_id = (SELECT auth.uid()) AND public.is_tenant_member(tenant_id));

CREATE POLICY audit_events_select_for_members
  ON public.audit_events FOR SELECT TO authenticated
  USING (
    public.is_tenant_member(tenant_id)
    AND public.has_tenant_role(tenant_id, ARRAY['tenant_admin', 'originator', 'analyst', 'reviewer', 'auditor'])
  );
CREATE POLICY audit_events_insert_for_actor
  ON public.audit_events FOR INSERT TO anvil_backend
  WITH CHECK (
    actor_id = (SELECT auth.uid())
    AND public.is_tenant_member(tenant_id)
  );

REVOKE ALL ON TABLE public.credit_cases, public.idempotency_keys, public.audit_events FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.credit_cases FROM authenticated;
REVOKE ALL ON TABLE public.idempotency_keys, public.audit_events FROM authenticated;
GRANT SELECT ON TABLE public.credit_cases TO authenticated, anvil_backend;
GRANT INSERT (tenant_id, entity_id, case_number, status, currency) ON TABLE public.credit_cases TO anvil_backend;
GRANT UPDATE (status, version, updated_at, deleted_at) ON TABLE public.credit_cases TO anvil_backend;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.idempotency_keys TO anvil_backend;
GRANT SELECT ON TABLE public.audit_events TO authenticated;
GRANT INSERT ON TABLE public.audit_events TO anvil_backend;
GRANT ALL ON TABLE public.credit_cases, public.idempotency_keys, public.audit_events TO service_role;

COMMENT ON TABLE public.credit_cases IS 'Tenant-scoped credit underwriting cases; deletion is represented by deleted_at.';
COMMENT ON TABLE public.idempotency_keys IS 'Tenant and actor scoped response replay records with bounded retention.';
COMMENT ON TABLE public.audit_events IS 'Append-only tenant audit trail for material mutations.';
COMMENT ON FUNCTION public.has_tenant_role(uuid, text[]) IS 'Checks the current auth.uid() for an active allowed role in one tenant.';

COMMIT;
