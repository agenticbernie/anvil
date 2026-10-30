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
# Set the API, Clerk, and Supabase public values in .env.local.
npm run dev
```

Get the Clerk publishable and secret keys from **Clerk Dashboard → Configure → Developers → API keys**. Put the publishable key in `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and the secret key in `CLERK_SECRET_KEY`; never add the secret key to a `NEXT_PUBLIC_` variable or commit `.env.local`.

Set `NEXT_PUBLIC_SUPABASE_URL` and the project's publishable key (or legacy anon key) from **Supabase Dashboard → Project Settings → API**. Supabase Auth must have the Clerk custom OIDC provider registered as `custom:clerk`. The frontend exchanges the Clerk session token for a short-lived Supabase session, then sends that Supabase access token to the NestJS API. Tokens remain in memory and are never written to local storage.

The API requires a tenant UUID. Configure a signed `tenant_id` UUID claim in Clerk session tokens, or use a Clerk organization whose ID is itself a UUID. Clerk's usual `org_...` IDs are not Anvil tenant UUIDs; in that case, map the active organization to the tenant UUID in a custom claim. The backend still checks active tenant membership for every request.

Open `http://localhost:3000/sign-in` to sign in. Protected routes redirect unauthenticated users to Clerk's sign-in page.

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
  components/           Presentational shell and Clerk account controls
  hooks/                TanStack Query case and mutation hooks
  lib/
    api/                Generated OpenAPI types, typed fetchers, encrypted upload flow
    auth/               Clerk-to-Supabase token exchange and tenant context
    supabase/           Ephemeral browser auth client for OIDC token exchange
```
