-- Run the application backfill while writers are stopped before applying this migration.
-- The constraint intentionally fails if any pre-existing response cache is still plaintext.
ALTER TABLE public.idempotency_keys
  ADD CONSTRAINT idempotency_response_body_encrypted_check
  CHECK (
    response_body IS NULL OR COALESCE((
      jsonb_typeof(response_body) = 'object'
      AND (response_body - 'format'::text - 'version'::text - 'payload'::text) = '{}'::jsonb
      AND response_body->>'format' = 'anvil.idempotency-response'
      AND response_body->>'version' = '1'
      AND jsonb_typeof(response_body->'payload') = 'object'
      AND ((response_body->'payload') - 'version'::text - 'keyVersion'::text - 'nonce'::text - 'ciphertext'::text) = '{}'::jsonb
      AND response_body->'payload'->>'version' = '1'
      AND jsonb_typeof(response_body->'payload'->'keyVersion') = 'string'
      AND jsonb_typeof(response_body->'payload'->'nonce') = 'string'
      AND jsonb_typeof(response_body->'payload'->'ciphertext') = 'string'
    ), false)
  );
