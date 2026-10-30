BEGIN;

DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM public.documents) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'Existing documents must be reuploaded with application encryption before this migration can run.';
  END IF;
END;
$migration$;

ALTER TABLE public.documents
  ADD COLUMN storage_size_bytes bigint NOT NULL,
  ADD COLUMN wrapped_data_key text NOT NULL,
  ADD COLUMN encryption_nonce text NOT NULL,
  ADD COLUMN encryption_key_version text NOT NULL,
  ADD CONSTRAINT documents_storage_size_valid
    CHECK (storage_size_bytes = size_bytes + 16),
  ADD CONSTRAINT documents_encryption_metadata_consistent
    CHECK (char_length(encryption_key_version) BETWEEN 2 AND 32
      AND split_part(wrapped_data_key, '.', 1) = encryption_key_version
      AND wrapped_data_key ~ '^v[1-9][0-9]*\.[A-Za-z0-9+/]{16}\.[A-Za-z0-9+/]{64}$'
      AND char_length(encryption_nonce) = 16);

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

COMMENT ON COLUMN public.documents.storage_size_bytes IS
  'Encrypted R2 object byte length; AES-256-GCM ciphertext includes a 16-byte authentication tag.';
COMMENT ON COLUMN public.documents.wrapped_data_key IS
  'Versioned AES-256-GCM envelope containing the per-document key encrypted by the application root key.';
COMMENT ON COLUMN public.documents.encryption_nonce IS
  'Base64-encoded 96-bit nonce used for client-side document encryption.';
COMMENT ON COLUMN public.documents.encryption_key_version IS
  'Application encryption root-key version; legacy-plaintext rows must be reuploaded before processing.';

COMMIT;
