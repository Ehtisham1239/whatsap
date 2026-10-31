-- 0002_enable_rls.sql
-- Reconstructed from the live catalog (applied 2026-10-30).
-- RLS is enabled with no policies: the Supabase anon/authenticated roles can
-- read or write nothing. The API server connects as the database owner
-- (DATABASE_URL) and enforces tenant isolation in every query itself.
alter table public.schema_migrations enable row level security;
alter table public.tenants enable row level security;
alter table public.waba_connections enable row level security;
alter table public.api_keys enable row level security;
alter table public.contacts enable row level security;
alter table public.conversation_windows enable row level security;
alter table public.conversations enable row level security;
alter table public.templates enable row level security;
alter table public.messages enable row level security;
alter table public.wallets enable row level security;
alter table public.credit_ledger enable row level security;
alter table public.idempotency_keys enable row level security;
alter table public.webhook_events enable row level security;
alter table public.webhook_endpoints enable row level security;
