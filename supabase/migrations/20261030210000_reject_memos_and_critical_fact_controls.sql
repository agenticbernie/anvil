BEGIN;

-- The base extraction migration already creates this column. IF NOT EXISTS also
-- upgrades installations that were initialized before criticality was added.
ALTER TABLE public.extracted_facts
  ADD COLUMN IF NOT EXISTS is_critical boolean NOT NULL DEFAULT false;

ALTER TABLE public.memo_versions
  ADD COLUMN IF NOT EXISTS rejected_by uuid REFERENCES auth.users (id),
  ADD COLUMN IF NOT EXISTS rejected_at timestamptz,
  ADD COLUMN IF NOT EXISTS rejection_reason_ciphertext jsonb;

ALTER TABLE public.memo_versions
  DROP CONSTRAINT IF EXISTS memo_versions_status_check;
ALTER TABLE public.memo_versions
  ADD CONSTRAINT memo_versions_status_check
    CHECK (status IN ('generating', 'draft', 'approved', 'rejected', 'failed'));

ALTER TABLE public.memo_versions
  ADD CONSTRAINT memo_versions_rejection_reason_encrypted
    CHECK (rejection_reason_ciphertext IS NULL OR
      (jsonb_typeof(rejection_reason_ciphertext) = 'object' AND rejection_reason_ciphertext ? 'ciphertext')),
  ADD CONSTRAINT memo_versions_rejection_metadata_consistent
    CHECK (
      (status = 'rejected' AND rejected_by IS NOT NULL AND rejected_at IS NOT NULL AND rejection_reason_ciphertext IS NOT NULL)
      OR
      (status <> 'rejected' AND rejected_by IS NULL AND rejected_at IS NULL AND rejection_reason_ciphertext IS NULL)
    );

COMMENT ON COLUMN public.extracted_facts.is_critical IS
  'Critical facts with unresolved conflicts require a documented memo override reason.';
COMMENT ON COLUMN public.memo_versions.rejection_reason_ciphertext IS
  'Application-encrypted reason recorded when a draft memo is rejected.';

COMMIT;
