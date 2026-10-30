# Anvil frontend MVP

This Next.js App Router app lives separately from the NestJS backend because the repository's root `src/` is the backend source tree. Its API contract is the root `../openapi.json`; runtime behavior follows `../ASTRYX_HANDBOOK.md`.

## Generate API types

From this directory:

```bash
npm install
npm run generate:api
```

`generate:api` runs `openapi-typescript ../openapi.json -o src/lib/api/schema.d.ts`. The generated `paths` and `components` are the types used by `src/lib/api/client.ts`; typed fetcher names follow OpenAPI `operationId` values so authentication and error handling stay centralized. Regenerate after changing the OpenAPI document, then run `npm run typecheck`.

## Run locally

```bash
cp .env.example .env.local
# Set NEXT_PUBLIC_API_BASE_URL to the API origin (OpenAPI currently has no `servers` entry).
npm run dev
```

Open `http://localhost:3000/cases`, then connect with a Supabase access token and tenant UUID. The MVP keeps credentials in React memory only. A Supabase Auth integration can call `connect(accessToken, tenantId)` from `useAuthTenant()` after sign-in.

## Contract boundaries

- The case list uses `GET /v1/cases` with the documented `limit` and `cursor` parameters. `nextCursor` is now typed as a nullable string.
- The case response contains `entityId`, not an entity name. The table therefore displays the identifier.
- Documents are read from `GET /v1/cases/{caseId}/documents`. The response does not contain filenames or business categories such as Lease/Invoice, so the UI shows the returned document ID and MIME type; locally uploaded filenames are shown only for the active page session. Storage keys and hashes are never rendered.
- Facts use `GET /v1/cases/{caseId}/facts?review_status=...`; decrypted fact values use no-store requests and are not persisted.
- `currentJobId` drives `GET /v1/jobs/{jobId}` polling every three seconds. Terminal job states stop polling and refresh the case, facts, documents, and memo queries.
- Memo versions come from `GET /v1/cases/{caseId}/memos`. TanStack Query retains only version metadata from that response; memo content is fetched by ID with a no-store request and no persistent cache.

## Structure

```text
src/
  app/                  App Router pages, layout, providers, and Tailwind/Astryx CSS
  components/           Presentational shell and session form
  hooks/                TanStack Query case and mutation hooks
  lib/
    api/                Generated OpenAPI types, typed fetchers, encrypted upload flow
    auth/               In-memory bearer and tenant context
```
