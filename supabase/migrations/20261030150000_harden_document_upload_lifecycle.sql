BEGIN;

ALTER TABLE public.documents
  ADD COLUMN final_object_key text,
  ADD COLUMN reservation_expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 minutes'),
  ADD COLUMN reservation_cleanup_locked_until timestamptz,
  ADD CONSTRAINT documents_final_object_key_format CHECK (
    final_object_key IS NULL OR final_object_key = object_key OR final_object_key LIKE
      ('tenants/' || tenant_id::text || '/cases/' || case_id::text || '/documents/finalized/%')
  ),
  ADD CONSTRAINT documents_final_object_key_unique UNIQUE (tenant_id, final_object_key);

UPDATE public.documents
SET final_object_key = object_key
WHERE status IN ('uploaded', 'processing', 'processed') AND final_object_key IS NULL;

CREATE INDEX documents_expired_reservations_idx
  ON public.documents (reservation_expires_at, reservation_cleanup_locked_until, id)
  WHERE status = 'pending_upload';

CREATE TABLE public.document_upload_actor_limits (
  tenant_id uuid NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,
  actor_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  window_start timestamptz NOT NULL,
  request_count integer NOT NULL CHECK (request_count BETWEEN 1 AND 50),
  PRIMARY KEY (tenant_id, actor_id, window_start)
);

CREATE TABLE public.document_upload_tenant_limits (
  tenant_id uuid NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,
  window_start timestamptz NOT NULL,
  request_count integer NOT NULL CHECK (request_count BETWEEN 1 AND 500),
  PRIMARY KEY (tenant_id, window_start)
);

ALTER TABLE public.document_upload_actor_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_upload_actor_limits FORCE ROW LEVEL SECURITY;
ALTER TABLE public.document_upload_tenant_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_upload_tenant_limits FORCE ROW LEVEL SECURITY;

CREATE POLICY document_upload_actor_limits_backend
  ON public.document_upload_actor_limits FOR ALL TO anvil_backend
  USING (public.is_tenant_member(tenant_id)
    AND public.has_tenant_role(tenant_id, ARRAY['tenant_admin', 'originator']))
  WITH CHECK (public.is_tenant_member(tenant_id)
    AND public.has_tenant_role(tenant_id, ARRAY['tenant_admin', 'originator']));

CREATE POLICY document_upload_tenant_limits_backend
  ON public.document_upload_tenant_limits FOR ALL TO anvil_backend
  USING (public.is_tenant_member(tenant_id)
    AND public.has_tenant_role(tenant_id, ARRAY['tenant_admin', 'originator']))
  WITH CHECK (public.is_tenant_member(tenant_id)
    AND public.has_tenant_role(tenant_id, ARRAY['tenant_admin', 'originator']));

REVOKE ALL ON TABLE public.document_upload_actor_limits, public.document_upload_tenant_limits FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.document_upload_actor_limits, public.document_upload_tenant_limits TO anvil_backend;
GRANT ALL ON TABLE public.document_upload_actor_limits, public.document_upload_tenant_limits TO service_role;

CREATE OR REPLACE FUNCTION public.guard_document_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.case_id IS DISTINCT FROM OLD.case_id
    OR NEW.uploaded_by IS DISTINCT FROM OLD.uploaded_by
    OR NEW.object_key IS DISTINCT FROM OLD.object_key
    OR NEW.content_type IS DISTINCT FROM OLD.content_type
    OR NEW.size_bytes IS DISTINCT FROM OLD.size_bytes
    OR NEW.storage_size_bytes IS DISTINCT FROM OLD.storage_size_bytes
    OR NEW.sha256 IS DISTINCT FROM OLD.sha256
    OR NEW.wrapped_data_key IS DISTINCT FROM OLD.wrapped_data_key
    OR NEW.encryption_nonce IS DISTINCT FROM OLD.encryption_nonce
    OR NEW.encryption_key_version IS DISTINCT FROM OLD.encryption_key_version
    OR NEW.reservation_expires_at IS DISTINCT FROM OLD.reservation_expires_at
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Immutable document fields cannot be changed.';
  END IF;

  IF NEW.final_object_key IS DISTINCT FROM OLD.final_object_key AND NOT (
    OLD.final_object_key IS NULL
    AND NEW.final_object_key IS NOT NULL
    AND OLD.status = 'pending_upload'
    AND NEW.status = 'uploaded'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Finalized object key can only be set during upload confirmation.';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status = 'pending_upload' AND NEW.status IN ('uploaded', 'failed')) OR
    (OLD.status = 'uploaded' AND NEW.status IN ('processing', 'rejected', 'failed')) OR
    (OLD.status = 'processing' AND NEW.status IN ('processed', 'rejected', 'failed'))
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Invalid document status transition.';
  END IF;
  IF NEW.status = 'uploaded' AND NEW.final_object_key IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Uploaded documents require a finalized object key.';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.claim_expired_document_reservations(p_limit integer DEFAULT 100)
RETURNS TABLE (tenant_id uuid, document_id uuid, staging_object_key text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  RETURN QUERY
  WITH candidates AS (
    SELECT document.id
    FROM public.documents AS document
    WHERE document.status = 'pending_upload'
      AND document.reservation_expires_at <= now()
      AND (document.reservation_cleanup_locked_until IS NULL OR document.reservation_cleanup_locked_until < now())
    ORDER BY document.reservation_expires_at, document.id
    LIMIT LEAST(GREATEST(p_limit, 1), 500)
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.documents AS document
  SET reservation_cleanup_locked_until = now() + interval '2 minutes'
  FROM candidates
  WHERE document.id = candidates.id
  RETURNING document.tenant_id, document.id, document.object_key;
END;
$function$;
REVOKE ALL ON FUNCTION public.claim_expired_document_reservations(integer) FROM PUBLIC, anon, authenticated, anvil_backend;
GRANT EXECUTE ON FUNCTION public.claim_expired_document_reservations(integer) TO service_role;

CREATE OR REPLACE FUNCTION public.purge_old_document_upload_limits()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  DELETE FROM public.document_upload_actor_limits
  WHERE window_start < date_trunc('hour', now()) - interval '1 hour';
  DELETE FROM public.document_upload_tenant_limits
  WHERE window_start < date_trunc('hour', now()) - interval '1 hour';
END;
$function$;
REVOKE ALL ON FUNCTION public.purge_old_document_upload_limits() FROM PUBLIC, anon, authenticated, anvil_backend;
GRANT EXECUTE ON FUNCTION public.purge_old_document_upload_limits() TO service_role;

COMMENT ON COLUMN public.documents.object_key IS 'Client-writable staging object key; parser workers never read this key.';
COMMENT ON COLUMN public.documents.final_object_key IS 'Server-only finalized object key copied from staging after conditional verification.';
COMMENT ON COLUMN public.documents.reservation_expires_at IS 'Pending upload reservation expiration; stale staging objects and rows are deleted by the maintenance worker.';
COMMENT ON FUNCTION public.claim_expired_document_reservations(integer) IS 'Bounded global service-role lease for expired staging reservations; tenant-scoped delete follows after R2 cleanup.';

COMMIT;
