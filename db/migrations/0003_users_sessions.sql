-- 0003_users_sessions.sql
-- Dashboard user accounts (email + password) and their login sessions.
-- Not yet applied to production; `npm run migrate` applies it.

create table public.users (
  id text primary key,
  tenant_id text not null references public.tenants(id) on delete cascade,
  email text not null check (email = lower(email) and char_length(email) <= 254 and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  name text not null check (char_length(name) between 1 and 100),
  role text not null default 'agent' check (role in ('owner', 'admin', 'agent')),
  password_hash text not null,
  disabled_at timestamptz,
  last_login_at timestamptz,
  created_at timestamptz not null,
  unique (email)
);
create index users_tenant_idx on public.users (tenant_id);

-- Only a SHA-256 of the session token is stored.
create table public.user_sessions (
  token_hash text primary key,
  user_id text not null references public.users(id) on delete cascade,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  last_seen_at timestamptz not null,
  user_agent text
);
create index user_sessions_user_idx on public.user_sessions (user_id);
create index user_sessions_expires_idx on public.user_sessions (expires_at);

alter table public.users enable row level security;
alter table public.user_sessions enable row level security;
