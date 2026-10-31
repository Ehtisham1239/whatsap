-- 0001_init.sql
-- Reconstructed on 2026-10-31 from the live catalog of Supabase project
-- "wa-platform" (ref wbrkkiqttxvhjrwuaipw), where it was applied on 2026-10-30.
-- Keep in sync with production; never edit an applied migration — add a new one.

create table if not exists public.schema_migrations (
  name text primary key,
  applied_at timestamptz not null default now()
);

create table public.tenants (
  id text primary key,
  name text not null,
  status text not null default 'trial' check (status in ('trial', 'active', 'pending_activation', 'suspended', 'cancelled')),
  timezone text not null default 'Asia/Karachi',
  created_at timestamptz not null
);

create table public.waba_connections (
  id text primary key,
  tenant_id text not null references public.tenants(id) on delete cascade,
  waba_id text not null,
  phone_number_id text not null unique,
  display_phone text not null,
  label text,
  token_cipher text not null,
  is_default boolean not null default false,
  status text not null check (status in ('connected', 'pending', 'disconnected')),
  quality_rating text,
  messaging_tier text,
  created_at timestamptz not null
);
create index waba_connections_tenant_idx on public.waba_connections (tenant_id);
create index waba_connections_waba_idx on public.waba_connections (waba_id);
create unique index waba_connections_one_default on public.waba_connections (tenant_id) where is_default;

create table public.api_keys (
  id text primary key,
  tenant_id text not null references public.tenants(id) on delete cascade,
  name text not null,
  prefix text not null,
  hash text not null unique,
  waba_connection_id text references public.waba_connections(id) on delete cascade,
  created_at timestamptz not null,
  last_used_at timestamptz,
  revoked_at timestamptz
);
create index api_keys_tenant_idx on public.api_keys (tenant_id);

create table public.contacts (
  id text primary key,
  tenant_id text not null references public.tenants(id) on delete cascade,
  phone text not null check (phone ~ '^[1-9][0-9]{7,14}$'),
  name text,
  source text not null default 'api',
  opted_out_at timestamptz,
  blocked_at timestamptz,
  block_reason text,
  created_at timestamptz not null,
  unique (tenant_id, phone)
);

create table public.conversation_windows (
  tenant_id text not null references public.tenants(id) on delete cascade,
  contact_id text not null references public.contacts(id) on delete cascade,
  waba_connection_id text not null references public.waba_connections(id) on delete cascade,
  last_inbound_at timestamptz not null,
  expires_at timestamptz not null,
  source text not null default 'user' check (source in ('user', 'ctwa')),
  primary key (contact_id, waba_connection_id)
);

create table public.conversations (
  id text primary key,
  tenant_id text not null references public.tenants(id) on delete cascade,
  contact_id text not null references public.contacts(id) on delete cascade,
  waba_connection_id text not null references public.waba_connections(id) on delete cascade,
  status text not null default 'open' check (status in ('open', 'pending', 'resolved')),
  last_message_at timestamptz not null,
  created_at timestamptz not null
);
create unique index conversations_one_active on public.conversations (contact_id, waba_connection_id) where status <> 'resolved';
create index conversations_tenant_recent_idx on public.conversations (tenant_id, last_message_at desc);

create table public.templates (
  id text primary key,
  tenant_id text not null references public.tenants(id) on delete cascade,
  waba_id text not null,
  name text not null check (name ~ '^[a-z0-9_]+$' and char_length(name) <= 512),
  language text not null,
  category text not null check (category in ('marketing', 'utility', 'authentication')),
  status text not null check (status in ('draft', 'pending', 'approved', 'rejected', 'paused', 'disabled')),
  components jsonb not null default '[]'::jsonb,
  variables text[] not null default '{}'::text[],
  parameter_format text not null default 'named' check (parameter_format in ('named', 'positional')),
  header_format text not null default 'none',
  meta_id text,
  reject_reason text,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (tenant_id, waba_id, name, language)
);

create table public.messages (
  id text primary key,
  tenant_id text not null references public.tenants(id) on delete cascade,
  conversation_id text not null references public.conversations(id) on delete restrict,
  contact_id text not null references public.contacts(id) on delete restrict,
  waba_connection_id text not null references public.waba_connections(id) on delete restrict,
  direction text not null check (direction in ('inbound', 'outbound')),
  mode text not null check (mode in ('custom', 'template', 'note')),
  type text not null,
  content jsonb not null,
  template_id text references public.templates(id) on delete set null,
  status text not null check (status in ('scheduled', 'queued', 'sent', 'delivered', 'read', 'failed', 'received', 'cancelled')),
  wamid text unique,
  error_code text,
  error_message text,
  credits_held integer not null default 0 check (credits_held >= 0),
  credits_refunded boolean not null default false,
  conversation_category text check (conversation_category in ('marketing', 'utility', 'authentication', 'service')),
  sent_via text not null,
  api_key_id text references public.api_keys(id) on delete set null,
  idempotency_key text,
  scheduled_for timestamptz,
  sent_at timestamptz,
  delivered_at timestamptz,
  read_at timestamptz,
  failed_at timestamptz,
  created_at timestamptz not null
);
create index messages_tenant_recent_idx on public.messages (tenant_id, created_at desc, id desc);
create index messages_tenant_status_idx on public.messages (tenant_id, status);
create index messages_contact_idx on public.messages (contact_id);
create index messages_stuck_idx on public.messages (created_at) where status = 'queued';

create table public.wallets (
  tenant_id text primary key references public.tenants(id) on delete cascade,
  balance integer not null default 0 check (balance >= 0)
);

create table public.credit_ledger (
  id text primary key,
  tenant_id text not null references public.tenants(id) on delete cascade,
  kind text not null check (kind in ('hold', 'refund', 'topup', 'adjustment')),
  amount integer not null,
  balance_after integer not null,
  message_id text,
  note text,
  created_at timestamptz not null
);
create index credit_ledger_tenant_recent_idx on public.credit_ledger (tenant_id, created_at desc, id desc);

create or replace function public.credit_ledger_append_only()
returns trigger
language plpgsql
set search_path to 'pg_catalog', 'public'
as $$
begin
  raise exception 'credit_ledger is append-only';
end;
$$;
create trigger credit_ledger_no_update before delete or update on public.credit_ledger
  for each row execute function public.credit_ledger_append_only();

create table public.idempotency_keys (
  tenant_id text not null references public.tenants(id) on delete cascade,
  key text not null,
  request_hash text not null,
  response_status integer,
  response jsonb,
  created_at timestamptz not null,
  primary key (tenant_id, key)
);
create index idempotency_keys_created_idx on public.idempotency_keys (created_at);

create table public.webhook_events (
  event_key text primary key,
  payload jsonb not null,
  received_at timestamptz not null
);
create index webhook_events_received_idx on public.webhook_events (received_at);

create table public.webhook_endpoints (
  id text primary key,
  tenant_id text not null references public.tenants(id) on delete cascade,
  url text not null,
  secret text not null,
  events text[] not null default '{*}'::text[],
  active boolean not null default true,
  created_at timestamptz not null
);
create index webhook_endpoints_tenant_idx on public.webhook_endpoints (tenant_id);
