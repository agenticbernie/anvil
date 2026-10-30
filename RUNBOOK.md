# Anvil Operations Runbook

## Safety and access

- Use the approved production dashboard and a least-privilege operator account. Database repair requires the designated privileged backend role.
- Search logs by request ID, worker name, status, and error code. Never paste JWTs, R2 presigned URLs, encryption keys, raw document text, fact values, request bodies, outbox payloads, or raw exception messages into tickets or chat.
- Worker logs and new processing-job `last_error` values use fixed messages. Migration `20261030190000_cleanup_finalized_staging_objects.sql` also scrubs older processing-job error text before normal operations resume.
- Review failed queue records within their retention window and preserve the durable PostgreSQL job/outbox records until the cause and recovery are understood. Avoid deleting a queue or truncating a table to clear an alert.
- Confirm tenant ID and resource ID together before any manual database action. Record the operator, change ticket, affected IDs, and resulting status.

## BullMQ document parse dead-letter queue is growing

The queue name is `document.parse.dlq`. The publisher enqueues a failed parse job after the matching `processing_jobs` row becomes terminal. New jobs use lazy BullMQ removal settings: completed jobs are eligible after 24 hours (with a 1,000-job count limit) and failed jobs after 7 days (with a 5,000-job count limit). The outbox worker also sweeps all queues at startup and hourly, removing expired completed/failed records including jobs created before these settings were deployed. It drains eligible records in Redis commands of at most 1,000 IDs until no expired records remain. DLQ and manual-review notifications still waiting or paused are swept after 7 days by the same process. PostgreSQL `processing_jobs`, `extraction_runs`, `outbox_events`, and audit events remain the durable operational record.

1. Check the DLQ queue counts and the rate of new entries. Inspect only job IDs, timestamps, and job names in dashboards; do not dump the job payload.
2. For each affected ID, check `processing_jobs` by both `tenant_id` and `id`. Review `status`, `attempt_count`, and `error_code`. Avoid selecting `last_error` into a shared terminal; older rows may contain upstream details until the sanitizing migration is applied.
3. Compare the error code with the worker logs, R2 availability, document checksum state, and recent deploys. Integrity or encryption failures require investigation of the object and reservation metadata before replay.
4. Restore the dependency or roll back the faulty deploy. Verify a single controlled retry succeeds before redriving a batch.
5. Drain or archive entries in bounded batches only after their matching database jobs have a known terminal outcome. Keep the original IDs in the incident record.

Do not call BullMQ `retry()` for a database job already marked `dead_lettered` or `failed`: the processing worker will refuse to acquire it. Terminal job recovery requires a reviewed, tenant-scoped repair that also restores a valid document lifecycle state and writes an audit event. There is no public retry API in this phase.

## Outbox events remain `pending` or `publishing`

`OutboxPublisherWorker` polls every second. The database claim function leases due events; expired `publishing` leases can be reclaimed. Publisher failures return to `pending` with exponential delay and eventually move to `dead_lettered` after the attempt limit.

Use a read-only query in the approved database console. Select only operational metadata; do not select `payload` or `last_error` into a shared terminal:

```sql
SELECT id, tenant_id, actor_id, event_type, status, publish_attempts,
       available_at, locked_until, created_at
FROM public.outbox_events
WHERE status IN ('pending', 'publishing', 'dead_lettered')
  AND available_at <= now()
ORDER BY created_at
LIMIT 100;
```

1. Check that the worker service is healthy and that it can connect to Upstash Redis and PostgreSQL.
2. For `publishing`, check `locked_until`. If the lease has not expired, allow the current publisher attempt to finish; do not change the row under an active lease.
3. Check queue availability and worker logs for the event type and safe error code. Confirm the corresponding queue is accepting jobs.
4. If a due event remains pending after the publisher is healthy, check its attempt count and whether it has become dead-lettered. Escalate a terminal event for reviewed replay; do not manually delete it or copy its payload into a command line.

## LLM API returns HTTP 429

The OpenAI adapters report the upstream status without logging the API key or response body. BullMQ work is configured for a bounded number of attempts with exponential backoff.

1. Check provider status, account rate limits, and request volume. Do not increase worker concurrency during a rate-limit incident.
2. Allow the existing retry/backoff window to complete. Watch extraction run and memo version status through metadata and error codes; do not expose document text or fact values in logs.
3. If 429s continue, reduce worker concurrency through the existing deployment configuration or pause worker deployment while preserving queued work.
4. After provider capacity is restored, verify one queued job succeeds before resuming normal concurrency. A terminal failed item must use the reviewed manual retry procedure below.

## Memo generation requests return HTTP 429 or 409

Memo generation is limited to 10 requests per actor and 100 requests per tenant in a rolling hour, with a lifetime cap of 100,000 retained requests per tenant. Both limits are enforced under a tenant transaction lock in the same database transaction as the outbox and audit writes, so a rejected request creates neither record. They apply across API instances.

1. Check the request volume and tenant ID using operational metrics; do not inspect memo contents or outbox payloads.
2. Allow the rolling window to expire. Do not bypass the limit by retrying with new idempotency keys or by submitting through another client.
3. For lifetime `409`, review tenant outbox counts through the restricted operational process. Do not delete audit or outbox rows to make room.
4. If the volume is expected, review worker backlog and provider capacity before adjusting the documented budget. Do not change it during an active abuse or provider incident.

## Case creation returns HTTP 429 or 409

Case creation is limited to 10 requests per actor and 100 requests per tenant in a rolling hour. A tenant may retain up to 10,000 cases across active and archived records. Hourly limits return `429`; the lifetime cap returns `409`. Budget checks take a tenant-scoped transaction lock, so they apply across API instances. The rejected create and audit event do not commit.

1. Check request volume, tenant ID, actor ID, and request IDs in operational metrics. Do not inspect request bodies or idempotency keys.
2. For `429`, allow the rolling window to expire. Do not retry with fresh keys to bypass the budget.
3. For lifetime `409`, review active and archived case counts with a tenant-scoped operational query. Do not delete audit or archived rows to make room.
4. If expected usage exceeds the current cap, review retention and product policy before changing the documented thresholds. Investigate unexpected volume as a possible account compromise or automation loop.

## Fact review update returns HTTP 429 or 409

Fact updates and verification events are limited to 10 per actor and 100 per tenant in a rolling hour, with a 100,000-event lifetime cap per tenant. The counters include both `fact.updated` and `fact.verified` audit events. A tenant-scoped transaction lock serializes the budget check with the fact and audit writes across API instances. Hourly exhaustion returns `429`; the lifetime cap returns `409`. Rejected changes do not update the fact or append an audit event.

1. Check request volume, tenant ID, actor ID, request IDs, and the safe response code in operational metrics. Do not inspect fact values or idempotency keys.
2. For `429`, allow the rolling hour to expire. Do not retry with fresh keys to bypass the budget.
3. For lifetime `409`, review the tenant's active and archived fact review event count through the approved operational process. Do not delete or rewrite audit rows; they are append-only evidence.
4. If expected review volume exceeds the cap, review audit storage policy and capacity before changing thresholds. Investigate unexpected volume as possible account compromise or automation loop.

## Document presign returns HTTP 429 or 409

Upload reservations are limited to 50 per actor and 500 per tenant per clock-hour bucket, with 10 active reservations per actor and 100 per tenant. Each tenant also has lifetime caps of 1,000 retained document rows and 10 GiB of declared ciphertext bytes. `429` means an active-reservation or hourly limit is exhausted; `409` means a lifetime cap is reached. The checks run under a tenant transaction lock. Failed and abandoned reservations count toward lifetime use because their metadata and audit rows are retained.

1. Check safe request metrics for tenant, actor, request ID, and response status. Do not inspect request bodies, signed URLs, encryption material, or object keys.
2. For `429`, allow active reservations to expire or the hourly window to pass; do not retry with new keys to bypass the budget.
3. For lifetime `409`, review tenant document count and declared ciphertext totals through the approved restricted operational process. Do not delete document or audit rows manually.
4. If an operational deletion and retention policy is introduced later, update the quota accounting and audit procedure together before releasing capacity. There is no finalized-document deletion workflow in this phase.

Completed BullMQ jobs across parse, extraction, memo, DLQ, and manual-review queues are eligible for removal after 24 hours; failed jobs after 7 days. BullMQ also applies lazy count limits of 1,000 completed and 5,000 failed jobs per queue when jobs finish. A startup/hourly sweeper removes expired terminal records in repeated batches of at most 1,000 IDs and expires waiting/paused DLQ and manual-review notifications after 7 days. PostgreSQL job, extraction-run, outbox, and audit records remain the durable record after BullMQ prunes a queue item.

## Idempotency response cache failed after a mutation

If the API reports that the operation may have succeeded and the idempotency claim was retained, the handler completed but the response cache write failed. The claim stays pending to prevent the same mutation from running twice.

1. Do not retry using a new idempotency key. The new key could repeat the mutation.
2. Reconcile the affected resource by tenant and resource ID using the approved application or database console. Avoid printing PII or response bodies.
3. Retry the original request only with the same key after confirming the claim has a completed response. Otherwise wait for the 24-hour claim expiry and reconcile the resource before taking further action.
4. If the same key returns `409` while pending, treat that as expected protection and escalate the cache/database failure with request ID and key hash only. Never log the raw key.

## Configure and rotate the idempotency fingerprint key

The production web service requires `IDEMPOTENCY_HASH_KEY_BASE64`, a canonical base64 encoding of 32 random bytes. The worker does not use this key and should not receive it. The active value is used for new HMAC-SHA-256 request fingerprints. `IDEMPOTENCY_HASH_KEY_PREVIOUS_BASE64` accepts comma-separated prior key values so retries of unexpired fingerprints continue to replay. The API also accepts legacy SHA-256 fingerprints until their 24-hour idempotency window expires. The web module fails startup when the active key is missing or invalid.

1. Generate key material with the approved secret manager; locally, `openssl rand -base64 32` produces the required format. Never put a real value in source control, command history, logs, or incident notes.
2. For rotation, set the new active value and retain every prior active value in `IDEMPOTENCY_HASH_KEY_PREVIOUS_BASE64`. Deploy the web service with both values together.
3. Keep each old key listed for at least 24 hours after the final service instance stopped writing hashes with it. Include a margin for in-flight requests and deployment rollback.
4. Remove old values only after that window. If a removed key is needed for rollback, restore it as a previous key before routing traffic to the older deployment.
5. Verify a same-key retry returns the original status/body and a changed request still returns `409`; inspect only response headers and safe status metadata, not stored response bodies or secret values.

Do not rotate the PII encryption key as part of this procedure. The idempotency HMAC key and PII encryption key are separate secrets with separate rotation plans.

The HTTP application owns `IdempotencyModule`; the worker does not need the HMAC key. Keep `IDEMPOTENCY_HASH_KEY_BASE64` and previous keys scoped to the web service.

## Confirmed uploads retain staging objects

Migration `20261030190000_cleanup_finalized_staging_objects.sql` adds a bounded lease for expired upload reservations and confirmed staging objects. Migration `20261030200000_tenant_document_storage_budget.sql` also makes the final key durable before R2 copy and lets cleanup reclaim both keys for expired, incomplete confirmations. Failed upload tombstones keep retrying deletion of any reserved finalized key every 24 hours, which catches a copy completing after an earlier delete. For completed documents, the worker deletes only the staging key; the finalized object remains the parser source. A failed delete is retried after the two-minute lease expires.

1. Check the worker health and R2 availability. Do not delete finalized keys or pending upload objects manually.
2. With a restricted database console, count eligible rows without selecting object contents:

   ```sql
   SELECT tenant_id, status, count(*)
   FROM public.documents
   WHERE reservation_expires_at <= now()
     AND (staging_cleanup_checked_at IS NULL OR staging_cleanup_checked_at <= now() - interval '24 hours')
     AND ((final_object_key IS NOT NULL AND final_object_key <> object_key)
       OR (final_object_key IS NULL AND status = 'failed'))
     AND reservation_expires_at <= now()
   GROUP BY tenant_id, status
   ORDER BY tenant_id, status;
   ```

3. Check worker logs for the fixed cleanup-failure event. Do not expose raw provider errors or R2 object keys in shared incident channels.
4. Restore worker or R2 access and allow the lease-based cleaner to retry. Verify the eligible count falls and finalized document processing still succeeds.
5. Alert if eligible rows remain after the worker is healthy for several polling cycles. A bucket-side lifecycle rule for the staging prefix is a useful external backstop; it must preserve finalized objects.

## Apply idempotency response encryption

Idempotency response bodies are encrypted with the configured PII key and authenticated against tenant, actor, key, and request hash. The `20261030170000_encrypt_idempotency_responses.sql` migration rejects plaintext response caches. Existing rows must be backfilled before applying it.

1. Schedule a maintenance window and stop all Anvil API writers. Keep them stopped through the backfill, migration, and deployment of the encrypted-cache application version.
2. Provide the one-time operator process with `IDEMPOTENCY_BACKFILL_DATABASE_URL` (a privileged PostgreSQL connection), `PII_ENCRYPTION_KEY_BASE64`, and `PII_ENCRYPTION_KEY_VERSION` through the approved secret manager. The backfill forces certificate-verified TLS, accepts only TLS-compatible `sslmode` hints, and rejects URL parameters that could override TLS. Do not put these values in shell history or tickets; do not weaken certificate verification to work around a connection error.
3. Build and preview the backfill. It prints only row counts and rolls back its transaction:

   ```bash
   npm run idempotency-cache:backfill -- --dry-run
   ```

4. Confirm the preview counts. For apply mode, set `IDEMPOTENCY_CACHE_BACKFILL_CONFIRM=I_HAVE_STOPPED_ANVIL_WRITERS` through the secret manager and run:

   ```bash
   npm run idempotency-cache:backfill -- --apply
   ```

5. Apply the Supabase migration. It fails closed if any non-null response cache remains plaintext. Deploy the application version that encrypts on write and decrypts only for scoped replay, then resume API traffic.
6. Verify one controlled idempotent mutation replays the same status and body. Confirm the database value has the `anvil.idempotency-response` envelope and contains no known response text. Never select or print the payload in shared logs.
7. Treat pre-remediation database snapshots as sensitive until their retention expires or the approved backup process replaces them; the backfill does not rewrite historical backups.

If the migration rejects existing data, keep writers stopped, rerun the count-only preview, and inspect backfill failures through restricted operator logs. Do not remove or disable the constraint to complete deployment.

## Manually retry a failed BullMQ job

This procedure is for a retained BullMQ job in `failed` state whose matching `processing_jobs` row is still `queued` or `retry_wait` with fewer than three database attempts. The sweeper removes expired completed jobs after 24 hours and failed jobs after 7 days; BullMQ may also apply its count limit when a later job finishes. A terminal database state cannot be replayed by queue retry alone.

1. Resolve the job ID from the incident record. Confirm the tenant, document, and case IDs using a tenant-scoped database query; do not print the payload.
2. Confirm the source object is still finalized in R2 and its stored size and digest match the immutable document declaration.
3. Use the application’s configured `document.parse` Queue connection in an approved operator script. Check the job state, then retry that exact failed job:

```ts
const job = await parseQueue.getJob(processingJobId);
if (!job) throw new Error('BullMQ job not found.');
if (await job.getState() !== 'failed') throw new Error('Only failed BullMQ jobs may be retried.');
await job.retry('failed');
```

4. Watch the job by ID and verify `processing_jobs.status` advances to `processing`, then `succeeded`. Confirm the expected outbox event was published.
5. If the database row is already `dead_lettered` or `failed`, stop. Create an incident-approved database repair and audit record before replay; do not reset status or counters ad hoc.

If the BullMQ job has expired or was pruned by the count limit, do not recreate it from a copied payload. Confirm the durable database state and use an incident-approved recovery that restores the job and audit state together; there is no public retry API in this phase.

For extraction or memo jobs, use the corresponding queue (`document.extract` or `memo.generate`) only after checking the matching extraction run or memo version. Their input-level uniqueness checks may return an existing result instead of repeating work.

## Escalation data

Include service name, deployment ID, UTC time range, request ID, queue name, job/event IDs, tenant ID, status, attempt count, and safe error code. Exclude credentials, signed URLs, PII, raw LLM prompts/responses, and document content.
# Clerk webhook delivery and IP filtering

The webhook endpoint is `POST /v1/webhooks/clerk`. Verify the endpoint's signing
secret in Clerk Dashboard → Webhooks and set it as `CLERK_WEBHOOK_SECRET`. Subscribe
to `user.created`, `organization.created`, and `organization_membership.created`.
Clerk retries failed deliveries; use the same webhook event ID for deduplication.

Security relies on cryptographic Svix signature verification, which is sufficient
for MVP. For production hardening, configure IP allowlisting at the Render/Cloudflare
edge level using the official Svix IP list: https://docs.svix.com/webhook-ips.json.
Avoid trusting `x-forwarded-for` inside the application unless the proxy chain is
explicitly configured and strips client-supplied forwarding headers.

If deliveries fail with a temporary error, check that the Supabase Clerk OIDC
identity is available and that `CLERK_WEBHOOK_SECRET` matches the Clerk endpoint.
An organization membership event can arrive before its organization event; the
service returns a retryable error until the organization tenant exists. Replay the
failed delivery from Clerk Dashboard → Webhooks → endpoint → Message Attempts.
