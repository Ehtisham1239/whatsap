-- 0006_ai_assistant.sql
-- Per-workspace AI assistant that answers inbound WhatsApp messages.
create table public.ai_assistants (
  tenant_id text primary key references public.tenants(id) on delete cascade,
  enabled boolean not null default false,
  business_name text not null default '' check (char_length(business_name) <= 120),
  instructions text not null default '' check (char_length(instructions) <= 12000),
  handoff_message text not null default '' check (char_length(handoff_message) <= 500),
  updated_at timestamptz not null
);
alter table public.ai_assistants enable row level security;

-- Set when the assistant hands a conversation to the team; the assistant stays
-- quiet there until a teammate turns it back on.
alter table public.conversations add column ai_paused boolean not null default false;
