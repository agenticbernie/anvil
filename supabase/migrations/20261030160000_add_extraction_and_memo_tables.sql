BEGIN;

CREATE TABLE public.document_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,
  case_id uuid NOT NULL,
  document_id uuid NOT NULL,
  version_number integer NOT NULL CHECK (version_number > 0),
  source_text_ciphertext bytea NOT NULL,
  source_text_nonce bytea NOT NULL CHECK (octet_length(source_text_nonce) = 12),
  source_text_key_version text NOT NULL CHECK (source_text_key_version ~ '^v[1-9][0-9]*$'),
  source_text_hash char(64) NOT NULL CHECK (source_text_hash ~ '^[a-f0-9]{64}$'),
  source_page_count integer NOT NULL CHECK (source_page_count > 0),
  source_kind text NOT NULL DEFAULT 'mock' CHECK (source_kind IN ('mock', 'ocr', 'text')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT document_versions_tenant_case_fk FOREIGN KEY (tenant_id, case_id)
    REFERENCES public.credit_cases (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT document_versions_tenant_document_fk FOREIGN KEY (tenant_id, document_id)
    REFERENCES public.documents (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT document_versions_tenant_id_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT document_versions_tenant_id_id_case_unique UNIQUE (tenant_id, id, case_id),
  CONSTRAINT document_versions_version_unique UNIQUE (tenant_id, document_id, version_number)
);
CREATE INDEX document_versions_tenant_case_idx ON public.document_versions (tenant_id, case_id, created_at DESC);

CREATE TABLE public.extraction_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,
  case_id uuid NOT NULL,
  document_version_id uuid NOT NULL,
  model_name text NOT NULL CHECK (char_length(model_name) BETWEEN 1 AND 128),
  prompt_hash char(64) NOT NULL CHECK (prompt_hash ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'processing'
    CHECK (status IN ('processing', 'retry_wait', 'succeeded', 'failed_validation', 'failed')),
  attempt_count smallint NOT NULL DEFAULT 1 CHECK (attempt_count BETWEEN 1 AND 3),
  cost_estimate numeric(12, 6) CHECK (cost_estimate IS NULL OR cost_estimate >= 0),
  validation_error_code text,
  lock_expires_at timestamptz,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT extraction_runs_tenant_case_fk FOREIGN KEY (tenant_id, case_id)
    REFERENCES public.credit_cases (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT extraction_runs_tenant_version_fk FOREIGN KEY (tenant_id, document_version_id, case_id)
    REFERENCES public.document_versions (tenant_id, id, case_id) ON DELETE CASCADE,
  CONSTRAINT extraction_runs_tenant_id_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT extraction_runs_tenant_id_id_case_unique UNIQUE (tenant_id, id, case_id),
  CONSTRAINT extraction_runs_input_unique UNIQUE (tenant_id, document_version_id, model_name, prompt_hash)
);
CREATE INDEX extraction_runs_tenant_case_idx ON public.extraction_runs (tenant_id, case_id, created_at DESC);

CREATE TABLE public.extracted_facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,
  extraction_run_id uuid NOT NULL,
  case_id uuid NOT NULL,
  field_name text NOT NULL CHECK (field_name ~ '^[a-z][a-z0-9_]{1,63}$'),
  raw_value jsonb NOT NULL CHECK (jsonb_typeof(raw_value) = 'object' AND raw_value ? 'ciphertext'),
  normalized_value jsonb NOT NULL CHECK (jsonb_typeof(normalized_value) = 'object' AND normalized_value ? 'ciphertext'),
  source_page integer NOT NULL CHECK (source_page > 0),
  confidence double precision NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  review_status text NOT NULL DEFAULT 'unverified'
    CHECK (review_status IN ('unverified', 'verified', 'needs_evidence', 'conflict', 'rejected')),
  is_critical boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT extracted_facts_tenant_case_fk FOREIGN KEY (tenant_id, case_id)
    REFERENCES public.credit_cases (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT extracted_facts_tenant_run_fk FOREIGN KEY (tenant_id, extraction_run_id, case_id)
    REFERENCES public.extraction_runs (tenant_id, id, case_id) ON DELETE CASCADE,
  CONSTRAINT extracted_facts_tenant_id_id_unique UNIQUE (tenant_id, id)
);
CREATE INDEX extracted_facts_tenant_case_review_idx
  ON public.extracted_facts (tenant_id, case_id, review_status, field_name);
CREATE INDEX extracted_facts_tenant_run_idx ON public.extracted_facts (tenant_id, extraction_run_id);

CREATE TABLE public.memo_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,
  case_id uuid NOT NULL,
  version_number integer NOT NULL CHECK (version_number > 0),
  input_hash char(64) NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'generating' CHECK (status IN ('generating', 'draft', 'approved', 'failed')),
  generation_attempts smallint NOT NULL DEFAULT 1 CHECK (generation_attempts BETWEEN 1 AND 3),
  generation_lock_expires_at timestamptz,
  content jsonb CHECK (content IS NULL OR (jsonb_typeof(content) = 'object' AND content ? 'ciphertext')),
  approved_by uuid REFERENCES auth.users (id),
  approval_override_ciphertext jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz,
  CONSTRAINT memo_versions_tenant_case_fk FOREIGN KEY (tenant_id, case_id)
    REFERENCES public.credit_cases (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT memo_versions_tenant_id_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT memo_versions_version_unique UNIQUE (tenant_id, case_id, version_number),
  CONSTRAINT memo_versions_input_unique UNIQUE (tenant_id, case_id, input_hash),
  CONSTRAINT memo_versions_override_encrypted CHECK (approval_override_ciphertext IS NULL OR
    (jsonb_typeof(approval_override_ciphertext) = 'object' AND approval_override_ciphertext ? 'ciphertext'))
);
CREATE INDEX memo_versions_tenant_case_idx ON public.memo_versions (tenant_id, case_id, version_number DESC);

ALTER TABLE public.outbox_events DROP CONSTRAINT outbox_events_job_id_required;
ALTER TABLE public.outbox_events DROP CONSTRAINT outbox_events_event_type_check;
ALTER TABLE public.outbox_events ADD CONSTRAINT outbox_events_event_type_check CHECK (event_type IN (
  'document.uploaded', 'document.parse.dead_lettered', 'document.extract.requested',
  'extraction.needs_manual_review', 'memo.generate.requested'
));
ALTER TABLE public.outbox_events ADD CONSTRAINT outbox_events_payload_shape_check CHECK (
  jsonb_typeof(payload) = 'object' AND payload ? 'caseId' AND
  CASE event_type
    WHEN 'document.uploaded' THEN payload ? 'processingJobId' AND payload ? 'documentId'
    WHEN 'document.parse.dead_lettered' THEN payload ? 'processingJobId' AND payload ? 'documentId'
    WHEN 'document.extract.requested' THEN payload ? 'processingJobId' AND payload ? 'documentId' AND payload ? 'documentVersionId'
    WHEN 'extraction.needs_manual_review' THEN payload ? 'documentId' AND payload ? 'extractionRunId'
    WHEN 'memo.generate.requested' THEN payload ? 'generationKey'
    ELSE false
  END
);

ALTER TABLE public.document_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE public.extraction_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.extraction_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE public.extracted_facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.extracted_facts FORCE ROW LEVEL SECURITY;
ALTER TABLE public.memo_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memo_versions FORCE ROW LEVEL SECURITY;

CREATE POLICY document_versions_select_member ON public.document_versions FOR SELECT TO anvil_backend
  USING (public.is_tenant_member(tenant_id) AND public.has_tenant_role(tenant_id, ARRAY['tenant_admin', 'originator', 'analyst', 'reviewer', 'auditor']));
CREATE POLICY document_versions_insert_originator ON public.document_versions FOR INSERT TO anvil_backend
  WITH CHECK (public.is_tenant_member(tenant_id) AND public.has_tenant_role(tenant_id, ARRAY['tenant_admin', 'originator', 'analyst']));

CREATE POLICY extraction_runs_select_member ON public.extraction_runs FOR SELECT TO anvil_backend
  USING (public.is_tenant_member(tenant_id) AND public.has_tenant_role(tenant_id, ARRAY['tenant_admin', 'originator', 'analyst', 'reviewer', 'auditor']));
CREATE POLICY extraction_runs_insert_editor ON public.extraction_runs FOR INSERT TO anvil_backend
  WITH CHECK ((SELECT auth.uid()) IS NOT NULL AND public.is_tenant_member(tenant_id)
    AND public.has_tenant_role(tenant_id, ARRAY['tenant_admin', 'originator', 'analyst']));
CREATE POLICY extraction_runs_update_editor ON public.extraction_runs FOR UPDATE TO anvil_backend
  USING (public.is_tenant_member(tenant_id) AND public.has_tenant_role(tenant_id, ARRAY['tenant_admin', 'originator', 'analyst']))
  WITH CHECK (public.is_tenant_member(tenant_id) AND public.has_tenant_role(tenant_id, ARRAY['tenant_admin', 'originator', 'analyst']));

CREATE POLICY extracted_facts_select_member ON public.extracted_facts FOR SELECT TO anvil_backend
  USING (public.is_tenant_member(tenant_id) AND public.has_tenant_role(tenant_id, ARRAY['tenant_admin', 'originator', 'analyst', 'reviewer', 'auditor']));
CREATE POLICY extracted_facts_insert_editor ON public.extracted_facts FOR INSERT TO anvil_backend
  WITH CHECK ((SELECT auth.uid()) IS NOT NULL AND public.is_tenant_member(tenant_id)
    AND public.has_tenant_role(tenant_id, ARRAY['tenant_admin', 'originator', 'analyst']));
CREATE POLICY extracted_facts_update_reviewers ON public.extracted_facts FOR UPDATE TO anvil_backend
  USING (public.is_tenant_member(tenant_id) AND public.has_tenant_role(tenant_id, ARRAY['tenant_admin', 'analyst', 'reviewer']))
  WITH CHECK (public.is_tenant_member(tenant_id) AND public.has_tenant_role(tenant_id, ARRAY['tenant_admin', 'analyst', 'reviewer']));

CREATE POLICY memo_versions_select_member ON public.memo_versions FOR SELECT TO anvil_backend
  USING (public.is_tenant_member(tenant_id) AND public.has_tenant_role(tenant_id, ARRAY['tenant_admin', 'originator', 'analyst', 'reviewer', 'auditor']));
CREATE POLICY memo_versions_insert_editor ON public.memo_versions FOR INSERT TO anvil_backend
  WITH CHECK ((SELECT auth.uid()) IS NOT NULL AND public.is_tenant_member(tenant_id)
    AND public.has_tenant_role(tenant_id, ARRAY['tenant_admin', 'analyst']));
CREATE POLICY memo_versions_update_reviewer ON public.memo_versions FOR UPDATE TO anvil_backend
  USING (public.is_tenant_member(tenant_id) AND public.has_tenant_role(tenant_id, ARRAY['tenant_admin', 'analyst', 'reviewer']))
  WITH CHECK (public.is_tenant_member(tenant_id) AND public.has_tenant_role(tenant_id, ARRAY['tenant_admin', 'analyst', 'reviewer']));

REVOKE ALL ON TABLE public.document_versions, public.extraction_runs, public.extracted_facts, public.memo_versions FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.document_versions, public.extraction_runs, public.extracted_facts, public.memo_versions TO anvil_backend;
GRANT ALL ON TABLE public.document_versions, public.extraction_runs, public.extracted_facts, public.memo_versions TO service_role;

COMMENT ON TABLE public.document_versions IS 'Encrypted extracted document text; source_kind=mock identifies the Phase 3 parser placeholder.';
COMMENT ON TABLE public.extraction_runs IS 'Tenant-scoped, idempotent LLM extraction attempts with prompt and model provenance.';
COMMENT ON TABLE public.extracted_facts IS 'Encrypted extracted fact values with page, confidence, and extraction run provenance.';
COMMENT ON TABLE public.memo_versions IS 'Encrypted, versioned structured credit memo drafts and approvals.';

COMMIT;
