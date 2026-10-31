-- 0004_broadcasts.sql
-- Bulk template sends ("broadcasts") and the time a message entered the send
-- queue (the stuck-send sweeper must not judge scheduled messages by created_at).

create table public.broadcasts (
  id text primary key,
  tenant_id text not null references public.tenants(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  waba_connection_id text not null references public.waba_connections(id) on delete restrict,
  template_id text references public.templates(id) on delete set null,
  template_name text not null,
  language text not null,
  status text not null default 'active' check (status in ('active', 'cancelled')),
  total integer not null check (total >= 0),
  skipped integer not null default 0 check (skipped >= 0),
  credits integer not null default 0 check (credits >= 0),
  created_by text,
  scheduled_for timestamptz not null,
  created_at timestamptz not null
);
create index broadcasts_tenant_recent_idx on public.broadcasts (tenant_id, created_at desc);

alter table public.messages add column broadcast_id text references public.broadcasts(id) on delete set null;
alter table public.messages add column queued_at timestamptz;
create index messages_broadcast_idx on public.messages (broadcast_id) where broadcast_id is not null;

alter table public.broadcasts enable row level security;
