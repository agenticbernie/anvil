BEGIN;

UPDATE public.processing_jobs
SET last_error = CASE error_code
  WHEN 'DOCUMENT_CHECKSUM_MISMATCH' THEN 'The uploaded document failed integrity verification.'
  WHEN 'DOCUMENT_ENCRYPTION_FAILED' THEN 'The uploaded document could not be decrypted.'
  ELSE 'Document processing failed.'
END
WHERE last_error IS NOT NULL;

ALTER TABLE public.documents
  ADD COLUMN staging_cleanup_checked_at timestamptz,
  ADD CONSTRAINT documents_staging_cleanup_state_valid CHECK (
    staging_cleanup_checked_at IS NULL OR
      (final_object_key IS NOT NULL AND final_object_key <> object_key) OR
      (final_object_key IS NULL AND status = 'failed')
  );

CREATE INDEX documents_staging_cleanup_idx
  ON public.documents (reservation_expires_at, staging_cleanup_checked_at, reservation_cleanup_locked_until, id)
  WHERE (final_object_key IS NOT NULL AND final_object_key <> object_key)
     OR (final_object_key IS NULL AND status = 'failed');

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

  IF NEW.staging_cleanup_checked_at IS DISTINCT FROM OLD.staging_cleanup_checked_at AND current_user <> 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Staging cleanup state is service-managed.';
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

CREATE OR REPLACE FUNCTION public.claim_document_staging_cleanup_retries(p_limit integer DEFAULT 100)
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
    WHERE ((document.final_object_key IS NOT NULL
        AND document.final_object_key <> document.object_key
        AND document.status IN ('uploaded', 'processing', 'processed', 'rejected', 'failed'))
      OR (document.final_object_key IS NULL AND document.status = 'failed'))
      AND document.reservation_expires_at <= now()
      AND (document.staging_cleanup_checked_at IS NULL
        OR document.staging_cleanup_checked_at <= now() - interval '24 hours')
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

REVOKE ALL ON FUNCTION public.claim_document_staging_cleanup_retries(integer) FROM PUBLIC, anon, authenticated, anvil_backend;
GRANT EXECUTE ON FUNCTION public.claim_document_staging_cleanup_retries(integer) TO service_role;

COMMENT ON COLUMN public.documents.staging_cleanup_checked_at IS
  'Service-managed timestamp of the most recent successful staging delete; eligible again daily to catch uploads completed after a prior delete.';
COMMENT ON FUNCTION public.claim_document_staging_cleanup_retries(integer) IS
  'Bounded service-role lease for expired failed reservations and confirmed staging objects; repeats daily to catch late in-flight PUT completions and never returns a finalized key.';
COMMENT ON COLUMN public.processing_jobs.last_error IS
  'Fixed safe summary only. Provider exception messages and stacks must not be persisted in this tenant-readable field.';

COMMIT;
