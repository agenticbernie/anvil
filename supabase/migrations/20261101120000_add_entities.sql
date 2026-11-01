BEGIN;

CREATE TABLE public.entities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,
  legal_name_ciphertext bytea NOT NULL CHECK (octet_length(legal_name_ciphertext) >= 16),
  legal_name_nonce bytea NOT NULL CHECK (octet_length(legal_name_nonce) = 12),
  legal_name_key_version text NOT NULL CHECK (char_length(legal_name_key_version) BETWEEN 1 AND 32),
  legal_name_blind_index char(64) NOT NULL CHECK (legal_name_blind_index ~ '^[a-f0-9]{64}$'),
  entity_type text NOT NULL CHECK (entity_type IN ('individual', 'business')),
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT entities_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE INDEX entities_tenant_name_blind_idx
  ON public.entities (tenant_id, legal_name_blind_index)
  WHERE deleted_at IS NULL;

ALTER TABLE public.entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.entities FORCE ROW LEVEL SECURITY;
CREATE POLICY entities_select_for_tenant_roles
  ON public.entities FOR SELECT TO anvil_backend
  USING (public.is_tenant_member(tenant_id)
    AND public.has_tenant_role(tenant_id, ARRAY['tenant_admin', 'originator', 'analyst', 'reviewer', 'auditor']));
CREATE POLICY entities_insert_for_creators
  ON public.entities FOR INSERT TO anvil_backend
  WITH CHECK (public.is_tenant_member(tenant_id)
    AND public.has_tenant_role(tenant_id, ARRAY['tenant_admin', 'originator'])
    AND deleted_at IS NULL);
REVOKE ALL ON TABLE public.entities FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.entities TO anvil_backend;
GRANT ALL ON TABLE public.entities TO service_role;

-- Keep old rows migratable while enforcing tenant-matched entities for new case rows.
ALTER TABLE public.credit_cases
  ADD CONSTRAINT credit_cases_tenant_entity_fk
  FOREIGN KEY (tenant_id, entity_id) REFERENCES public.entities (tenant_id, id) NOT VALID;

COMMIT;
