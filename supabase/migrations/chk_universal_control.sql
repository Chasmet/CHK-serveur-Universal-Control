-- Dedicated tables for hosted Supabase CHK Universal router.
-- Existing CHK gateway and other Supabase functions are untouched.
create table if not exists public.chk_uc_access (
 id uuid primary key default gen_random_uuid(),
 label text not null check (length(label) <= 100),
 secret_hash text not null unique check (length(secret_hash) = 64),
 active boolean not null default true,
 created_at timestamptz not null default now()
);
create table if not exists public.chk_uc_apps (
 id text primary key check (id ~ '^[a-z0-9][a-z0-9-]{1,47}$'),
 name text not null check (length(name) between 1 and 100),
 enabled boolean not null default false,
 endpoint text not null check (length(endpoint) between 20 and 2048 and endpoint ~ '^https://'),
 read_tools text[] not null default '{}',
 write_tools text[] not null default '{}',
 allow_writes boolean not null default false,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 constraint chk_uc_tool_bound check (cardinality(read_tools) <= 100 and cardinality(write_tools) <= 100)
);
create table if not exists public.chk_uc_audit (
 id uuid primary key default gen_random_uuid(),
 created_at timestamptz not null default now(),
 app_id text,
 operation text not null check (length(operation) <= 80),
 outcome text not null check (length(outcome) <= 32),
 request_id text
);
create index if not exists chk_uc_audit_latest on public.chk_uc_audit(created_at desc);
create unique index if not exists chk_uc_audit_write_id_unique on public.chk_uc_audit(request_id) where request_id is not null;
alter table public.chk_uc_access enable row level security;
alter table public.chk_uc_apps enable row level security;
alter table public.chk_uc_audit enable row level security;
revoke all on table public.chk_uc_access, public.chk_uc_apps, public.chk_uc_audit from anon, authenticated;
grant all on table public.chk_uc_access, public.chk_uc_apps, public.chk_uc_audit to service_role;
-- Seed app endpoints/tokens separately using Supabase dashboard secrets and SQL, never in Git.
