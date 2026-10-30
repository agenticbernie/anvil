BEGIN;

-- The quota query is tenant-scoped and aggregates immutable storage byte declarations.
CREATE INDEX IF NOT EXISTS documents_tenant_storage_quota_idx
  ON public.documents (tenant_id, storage_size_bytes);

COMMENT ON INDEX public.documents_tenant_storage_quota_idx IS
  'Supports tenant-scoped lifetime document count and ciphertext byte budget checks.';

ALTER TABLE public.documents
  ADD COLUMN finalization_cleanup_pending boolean NOT NULL DEFAULT false;

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
  IF NEW.finalization_cleanup_pending IS DISTINCT FROM OLD.finalization_cleanup_pending AND current_user <> 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Finalization cleanup state is service-managed.';
  END IF;
  IF NEW.final_object_key IS DISTINCT FROM OLD.final_object_key AND NOT (
    OLD.final_object_key IS NULL AND NEW.final_object_key IS NOT NULL AND OLD.status = 'pending_upload'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Finalized object key can only be reserved once for a pending upload.';
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

-- Keep a pre-copy final key durable so a crash or failed DB commit leaves cleanup work discoverable.
CREATE OR REPLACE FUNCTION public.claim_expired_document_reservations_with_finalized_object(p_limit integer DEFAULT 100)
RETURNS TABLE (tenant_id uuid, document_id uuid, staging_object_key text, finalized_object_key text)
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
  RETURNING document.tenant_id, document.id, document.object_key, document.final_object_key;
END;
$function$;
REVOKE ALL ON FUNCTION public.claim_expired_document_reservations_with_finalized_object(integer) FROM PUBLIC, anon, authenticated, anvil_backend;
GRANT EXECUTE ON FUNCTION public.claim_expired_document_reservations_with_finalized_object(integer) TO service_role;

COMMENT ON COLUMN public.documents.final_object_key IS
  'Server-reserved finalized object key; persisted before R2 copy so expired/incomplete finalizations can be reclaimed.';
COMMENT ON COLUMN public.documents.reservation_expires_at IS
  'Expired pending reservation becomes a failed tombstone after staging and any pre-finalized object are removed.';
COMMENT ON FUNCTION public.claim_expired_document_reservations_with_finalized_object(integer) IS
  'Leases expired pending uploads and returns both staging and any reserved finalized key for idempotent cleanup.';

CREATE OR REPLACE FUNCTION public.claim_document_staging_cleanup_retries_with_finalized_key(p_limit integer DEFAULT 100)
RETURNS TABLE (tenant_id uuid, document_id uuid, staging_object_key text, finalized_cleanup_object_key text)
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
  RETURNING document.tenant_id, document.id, document.object_key,
    CASE WHEN document.finalization_cleanup_pending THEN document.final_object_key ELSE NULL END;
END;
$function$;
REVOKE ALL ON FUNCTION public.claim_document_staging_cleanup_retries_with_finalized_key(integer) FROM PUBLIC, anon, authenticated, anvil_backend;
GRANT EXECUTE ON FUNCTION public.claim_document_staging_cleanup_retries_with_finalized_key(integer) TO service_role;

COMMENT ON COLUMN public.documents.finalization_cleanup_pending IS
  'Service-managed marker that retries deletion of reserved final keys on expired failed upload tombstones to catch late R2 copies.';
COMMENT ON FUNCTION public.claim_document_staging_cleanup_retries_with_finalized_key(integer) IS
  'Leases expired staging cleanup candidates and returns a finalized key only for failed upload tombstones still awaiting late-copy cleanup.';

COMMIT;
