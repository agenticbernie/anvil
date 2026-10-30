BEGIN;

GRANT EXECUTE ON FUNCTION public.is_tenant_member(uuid) TO anvil_backend;
GRANT EXECUTE ON FUNCTION public.has_tenant_role(uuid, text[]) TO anvil_backend;
GRANT EXECUTE ON FUNCTION auth.uid() TO anvil_backend;

ALTER TABLE public.credit_cases ADD CONSTRAINT credit_cases_tenant_id_id_unique UNIQUE (tenant_id, id);

CREATE TABLE public.documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,
  case_id uuid NOT NULL,
  uploaded_by uuid NOT NULL REFERENCES auth.users (id),
  object_key text NOT NULL CHECK (char_length(object_key) BETWEEN 1 AND 1024),
  content_type text NOT NULL CHECK (content_type IN ('application/pdf', 'image/jpeg', 'image/png', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')),
  size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 1 AND 1073741824),
  sha256 char(64) NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'pending_upload'
    CHECK (status IN ('pending_upload', 'uploaded', 'processing', 'processed', 'rejected', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT documents_tenant_case_fk FOREIGN KEY (tenant_id, case_id)
    REFERENCES public.credit_cases (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT documents_tenant_object_key_unique UNIQUE (tenant_id, object_key),
  CONSTRAINT documents_tenant_id_id_unique UNIQUE (tenant_id, id)
);
CREATE INDEX documents_tenant_case_created_idx
  ON public.documents (tenant_id, case_id, created_at DESC, id DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX documents_tenant_sha256_idx ON public.documents (tenant_id, sha256);

CREATE TABLE public.processing_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,
  case_id uuid NOT NULL,
  document_id uuid NOT NULL,
  actor_id uuid NOT NULL REFERENCES auth.users (id),
  job_type text NOT NULL CHECK (job_type IN ('document.parse')),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'processing', 'retry_wait', 'succeeded', 'failed', 'dead_lettered')),
  progress smallint NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  attempt_count smallint NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 3),
  error_code text,
  last_error text,
  worker_version text,
  available_at timestamptz NOT NULL DEFAULT now(),
  lock_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  CONSTRAINT processing_jobs_tenant_case_fk FOREIGN KEY (tenant_id, case_id)
    REFERENCES public.credit_cases (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT processing_jobs_tenant_document_fk FOREIGN KEY (tenant_id, document_id)
    REFERENCES public.documents (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT processing_jobs_tenant_id_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT processing_jobs_document_type_unique UNIQUE (tenant_id, document_id, job_type)
);
CREATE INDEX processing_jobs_tenant_status_available_idx
  ON public.processing_jobs (tenant_id, status, available_at, created_at);

CREATE TABLE public.outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,
  actor_id uuid NOT NULL REFERENCES auth.users (id),
  event_type text NOT NULL CHECK (event_type IN ('document.uploaded', 'document.parse.dead_lettered')),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'publishing', 'published', 'dead_lettered')),
  publish_attempts smallint NOT NULL DEFAULT 0 CHECK (publish_attempts BETWEEN 0 AND 10),
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  CONSTRAINT outbox_events_tenant_id_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT outbox_events_job_id_required CHECK (payload ? 'processingJobId' AND payload ? 'documentId' AND payload ? 'caseId')
);
CREATE INDEX outbox_events_tenant_status_available_idx
  ON public.outbox_events (tenant_id, status, available_at, created_at);

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
    OR NEW.sha256 IS DISTINCT FROM OLD.sha256
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Immutable document fields cannot be changed.';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status = 'pending_upload' AND NEW.status IN ('uploaded', 'failed')) OR
    (OLD.status = 'uploaded' AND NEW.status IN ('processing', 'rejected', 'failed')) OR
    (OLD.status = 'processing' AND NEW.status IN ('processed', 'rejected', 'failed'))
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Invalid document status transition.';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER documents_guard_update
  BEFORE UPDATE ON public.documents
  FOR EACH ROW EXECUTE FUNCTION public.guard_document_update();

CREATE OR REPLACE FUNCTION public.claim_pending_outbox_events(p_limit integer DEFAULT 25)
RETURNS TABLE (event_id uuid, tenant_id uuid, actor_id uuid, event_type text, payload jsonb, publish_attempts smallint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  RETURN QUERY
  WITH candidates AS (
    SELECT event.id
    FROM public.outbox_events AS event
    WHERE (event.status = 'pending' AND event.available_at <= now())
       OR (event.status = 'publishing' AND event.locked_until < now())
    ORDER BY event.created_at, event.id
    LIMIT LEAST(GREATEST(p_limit, 1), 100)
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.outbox_events AS event
  SET status = 'publishing',
      publish_attempts = LEAST(event.publish_attempts + 1, 10),
      locked_until = now() + interval '60 seconds'
  FROM candidates
  WHERE event.id = candidates.id
  RETURNING event.id, event.tenant_id, event.actor_id, event.event_type, event.payload, event.publish_attempts;
END;
$function$;
REVOKE ALL ON FUNCTION public.claim_pending_outbox_events(integer) FROM PUBLIC, anon, authenticated, anvil_backend;
GRANT EXECUTE ON FUNCTION public.claim_pending_outbox_events(integer) TO service_role;

ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.documents FORCE ROW LEVEL SECURITY;
ALTER TABLE public.processing_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.processing_jobs FORCE ROW LEVEL SECURITY;
ALTER TABLE public.outbox_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outbox_events FORCE ROW LEVEL SECURITY;

CREATE POLICY documents_select_for_members
  ON public.documents FOR SELECT TO authenticated, anvil_backend
  USING (public.is_tenant_member(tenant_id)
    AND public.has_tenant_role(tenant_id, ARRAY['tenant_admin', 'originator', 'analyst', 'reviewer', 'auditor']));
CREATE POLICY documents_insert_for_originators
  ON public.documents FOR INSERT TO anvil_backend
  WITH CHECK (uploaded_by = (SELECT auth.uid())
    AND public.is_tenant_member(tenant_id)
    AND public.has_tenant_role(tenant_id, ARRAY['tenant_admin', 'originator']));
CREATE POLICY documents_update_for_originators
  ON public.documents FOR UPDATE TO anvil_backend
  USING (public.is_tenant_member(tenant_id)
    AND public.has_tenant_role(tenant_id, ARRAY['tenant_admin', 'originator', 'analyst']))
  WITH CHECK (public.is_tenant_member(tenant_id)
    AND public.has_tenant_role(tenant_id, ARRAY['tenant_admin', 'originator', 'analyst']));

CREATE POLICY processing_jobs_select_for_members
  ON public.processing_jobs FOR SELECT TO authenticated, anvil_backend
  USING (public.is_tenant_member(tenant_id)
    AND public.has_tenant_role(tenant_id, ARRAY['tenant_admin', 'originator', 'analyst', 'reviewer', 'auditor']));
CREATE POLICY processing_jobs_insert_for_members
  ON public.processing_jobs FOR INSERT TO anvil_backend
  WITH CHECK (actor_id = (SELECT auth.uid())
    AND public.is_tenant_member(tenant_id)
    AND public.has_tenant_role(tenant_id, ARRAY['tenant_admin', 'originator']));
CREATE POLICY processing_jobs_update_for_members
  ON public.processing_jobs FOR UPDATE TO anvil_backend
  USING (public.is_tenant_member(tenant_id)
    AND public.has_tenant_role(tenant_id, ARRAY['tenant_admin', 'originator', 'analyst']))
  WITH CHECK (public.is_tenant_member(tenant_id)
    AND public.has_tenant_role(tenant_id, ARRAY['tenant_admin', 'originator', 'analyst']));

CREATE POLICY outbox_events_select_for_members
  ON public.outbox_events FOR SELECT TO anvil_backend
  USING (public.is_tenant_member(tenant_id)
    AND public.has_tenant_role(tenant_id, ARRAY['tenant_admin', 'originator', 'analyst']));
CREATE POLICY outbox_events_insert_for_actor
  ON public.outbox_events FOR INSERT TO anvil_backend
  WITH CHECK (actor_id = (SELECT auth.uid())
    AND public.is_tenant_member(tenant_id)
    AND public.has_tenant_role(tenant_id, ARRAY['tenant_admin', 'originator', 'analyst']));
CREATE POLICY outbox_events_update_for_members
  ON public.outbox_events FOR UPDATE TO anvil_backend
  USING (public.is_tenant_member(tenant_id)
    AND public.has_tenant_role(tenant_id, ARRAY['tenant_admin', 'originator', 'analyst']))
  WITH CHECK (public.is_tenant_member(tenant_id)
    AND public.has_tenant_role(tenant_id, ARRAY['tenant_admin', 'originator', 'analyst']));

REVOKE ALL ON TABLE public.documents, public.processing_jobs, public.outbox_events FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.documents, public.processing_jobs, public.outbox_events FROM authenticated;
GRANT SELECT ON TABLE public.documents, public.processing_jobs TO authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.documents, public.processing_jobs, public.outbox_events TO anvil_backend;
GRANT ALL ON TABLE public.documents, public.processing_jobs, public.outbox_events TO service_role;

COMMENT ON TABLE public.documents IS 'Tenant-scoped document metadata; object bytes remain in private R2 storage.';
COMMENT ON TABLE public.processing_jobs IS 'Durable status and retry state for asynchronous document work.';
COMMENT ON TABLE public.outbox_events IS 'Transactional outbox used to publish durable queue work.';
COMMENT ON FUNCTION public.claim_pending_outbox_events(integer) IS 'Atomically leases a bounded batch for the trusted worker publisher.';

COMMIT;
