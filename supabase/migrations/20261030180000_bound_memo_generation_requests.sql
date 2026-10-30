BEGIN;

-- Supports the tenant-scoped hourly request budget for asynchronous memo generation.
CREATE INDEX outbox_events_memo_generation_budget_idx
  ON public.outbox_events (tenant_id, created_at, actor_id)
  WHERE event_type = 'memo.generate.requested';

COMMENT ON INDEX public.outbox_events_memo_generation_budget_idx IS
  'Bounds hourly memo generation requests per actor and tenant without scanning outbox payloads.';

COMMIT;
