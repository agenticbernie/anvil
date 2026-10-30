BEGIN;

ALTER TABLE public.users
  ADD COLUMN clerk_user_id text UNIQUE;

ALTER TABLE public.tenants
  ADD COLUMN provisioned_by_clerk_user_id text UNIQUE;

CREATE TABLE public.clerk_webhook_events (
  event_id text PRIMARY KEY,
  event_type text NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.clerk_webhook_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.clerk_webhook_events FROM anon, authenticated;
GRANT ALL ON TABLE public.clerk_webhook_events TO service_role;

COMMIT;
