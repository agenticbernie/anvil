# Astryx MCP Handoff

## OpenAPI source

Use the generated [`openapi.json`](./openapi.json) as the source of truth for client generation. Regenerate it after changing a controller or DTO:

```bash
npm run openapi:generate
```

The running API also serves Swagger UI at `/docs` and its JSON document at `/docs/openapi.json` when `SWAGGER_ENABLED=true`. The default business API prefix is `/v1`; health endpoints remain at `/health/live`, `/health/ready`, and `/health/dependencies`.

Generate the client from the JSON document directly. Do not scrape the Swagger UI HTML. Keep the OpenAPI file in the same commit as controller and DTO changes so frontend generation is reproducible.

## Component and operation names

- DTO schema names use the exported TypeScript class name, in PascalCase. Request DTOs end in `Dto`; response DTOs end in `ResponseDto` or `PageResponseDto`.
- Keep DTO class names unique across modules. Renaming one changes the generated client type and should be treated as a client contract change.
- Operation IDs use `<ControllerClass>_<methodName>`. Use these IDs as generated client method names; avoid deriving method names from route text.
- Enum values and JSON property names are case sensitive. Preserve snake_case fields such as `job_id` and `override_reason` exactly as documented.
- All examples are synthetic. Values marked `REDACTED` or surrounded by angle brackets are placeholders, not usable credentials or ciphertext.

## Authentication and tenant selection

Business routes require a Supabase access token:

```http
Authorization: Bearer <supabase-access-token>
x-tenant-id: <tenant-uuid>
```

Pass the tenant UUID in the `x-tenant-id` header. The API checks active membership and derives authorization from the authenticated user. Do not send `tenant_id` in a request body or treat a client-supplied tenant ID as authority. Do not persist or log access tokens.

Presigned document upload responses include a one-time encryption key for the uploader and a short-lived signed upload URL. The response sets `Cache-Control: no-store`; generated clients and gateways must preserve this header and must not cache or persist the body. Keep the key in memory only, use it to encrypt the file before the R2 upload, and never include it in logs, analytics, crash reports, or support tickets.

The `requiredHeaders` example includes the ciphertext `content-length` (plaintext size plus the 16-byte AES-GCM tag), `content-type`, and `x-amz-meta-sha256`. Send these headers exactly as returned; changing them invalidates the signed upload request.

Upload reservations are bounded per tenant: at most 1,000 retained document rows and 10 GiB of declared ciphertext over the tenant lifetime. The presign endpoint returns `409` when either lifetime cap is reached and `429` when active-reservation or hourly limits are exhausted. Failed and abandoned reservations count toward the lifetime cap because their durable document and audit rows are retained.

Memo and fact responses containing decrypted values set `Cache-Control: no-store`. Generated clients and any gateway layer must preserve this response header and must not persist these response bodies in application caches.

## Idempotency

These mutations require a stable `Idempotency-Key` header:

- `POST /v1/cases`
- `PATCH /v1/cases/{id}`
- `POST /v1/cases/{id}/archive`
- `PATCH /v1/facts/{factId}`
- `POST /v1/cases/{caseId}/memos/generate`

Use a new key for a new user intent. Reuse the same key when retrying the same method, path, and body. The same key with a different request returns `409 Conflict`. Do not reuse a key across users or tenants.

The API stores a keyed HMAC fingerprint of the canonical request. Existing unexpired SHA-256 fingerprints remain replayable during the 24-hour compatibility window; callers should continue using the original key and identical request data while retrying.

## Asynchronous responses

`POST /v1/documents/{documentId}/confirm-upload` and memo generation return `202 Accepted`. Treat their `job_id` or `jobId` as an asynchronous work identifier; do not assume parsing or memo generation is complete when the HTTP response arrives.

## Errors

The contract documents `400`, `401`, `403`, `404`, `409`, `422`, and `500` responses with examples. Memo generation, case creation, fact review, and document presign also document `429 Too Many Requests` when actor or tenant hourly budgets are exhausted. Case creation allows 10 requests per actor and 100 per tenant in a rolling hour, with a 10,000 case lifetime cap per tenant; fact review updates allow 10 per actor and 100 per tenant per rolling hour, with a 100,000 update lifetime cap per tenant. Memo generation allows 10 requests per actor and 100 per tenant per rolling hour, with a 100,000 request lifetime cap per tenant. Document reservations allow 50 per actor and 500 per tenant per hour, 10 active reservations per actor and 100 per tenant, plus the 1,000-row and 10 GiB tenant lifetime caps. Hitting a lifetime cap returns `409 Conflict`. ValidationPipe currently reports request DTO validation as `400 Bad Request`; `422` is reserved for semantically unprocessable input if an endpoint emits it. Build client error handling from the HTTP status and documented response shape, and show safe actionable messages without displaying raw server stack traces.

If a mutation returns an error saying its idempotency claim was retained, the business operation may already have committed. Do not retry with a new key. Reconcile the resource state with the user, then retry with the same key only after the original claim is resolved or expires.
