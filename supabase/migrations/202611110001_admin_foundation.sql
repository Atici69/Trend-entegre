-- Trend-Entegre admin database foundation
-- Apply in Supabase SQL Editor. API secrets must never be stored in these tables.

create extension if not exists pgcrypto;

create table if not exists public.customers (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  company_name text,
  email text not null unique,
  phone text,
  status text not null default 'active' check (status in ('active','inactive','suspended')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references public.customers(id) on delete set null,
  package_name text not null,
  status text not null default 'pending' check (status in ('trial','active','past_due','cancelled','expired','pending')),
  starts_at timestamptz,
  ends_at timestamptz,
  amount numeric(12,2),
  currency text not null default 'TRY',
  created_at timestamptz not null default now()
);

create table if not exists public.dealers (
  id uuid primary key default gen_random_uuid(),
  parent_dealer_id uuid references public.dealers(id) on delete set null,
  company_name text not null,
  contact_name text,
  email text not null unique,
  commission_rate numeric(5,2) not null default 0 check (commission_rate between 0 and 100),
  status text not null default 'pending' check (status in ('pending','active','inactive','suspended')),
  created_at timestamptz not null default now()
);

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references public.customers(id) on delete set null,
  subscription_id uuid references public.subscriptions(id) on delete set null,
  provider text not null default 'manual',
  provider_reference text,
  amount numeric(12,2) not null check (amount >= 0),
  currency text not null default 'TRY',
  status text not null default 'pending' check (status in ('pending','paid','failed','refunded')),
  paid_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.admin_audit_logs (
  id bigint generated always as identity primary key,
  admin_user_id uuid,
  admin_email text not null,
  action text not null,
  resource_type text,
  resource_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists customers_created_at_idx on public.customers(created_at desc);
create index if not exists subscriptions_status_idx on public.subscriptions(status);
create index if not exists dealers_status_idx on public.dealers(status);
create index if not exists payments_created_at_idx on public.payments(created_at desc);
create index if not exists admin_audit_logs_created_at_idx on public.admin_audit_logs(created_at desc);

-- All admin data is accessed by the server using the service-role key after
-- validating the Supabase Auth JWT and ADMIN_EMAILS allowlist.
alter table public.customers enable row level security;
alter table public.subscriptions enable row level security;
alter table public.dealers enable row level security;
alter table public.payments enable row level security;
alter table public.admin_audit_logs enable row level security;

revoke all on public.customers, public.subscriptions, public.dealers, public.payments, public.admin_audit_logs from anon, authenticated;
grant all on public.customers, public.subscriptions, public.dealers, public.payments, public.admin_audit_logs to service_role;
grant usage, select on sequence public.admin_audit_logs_id_seq to service_role;
