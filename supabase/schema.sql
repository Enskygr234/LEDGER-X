-- =====================================================================
-- LEDGER X — Supabase schema, triggers and Row Level Security
-- Run once in the Supabase SQL editor (or `supabase db push`).
--
-- Mirrors the device's synchronised tables. Every row belongs to one auth
-- user; RLS guarantees users can only read and write their own rows.
-- Rows are never hard-deleted by the app (soft delete via deleted_at), so
-- no DELETE policy is granted.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- Shared trigger: stamp server_updated_at and enforce optimistic versioning
-- ---------------------------------------------------------------------
create or replace function public.lx_before_write() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.version is distinct from 1 then
      raise exception 'version must start at 1' using errcode = 'P0001';
    end if;
    new.user_id := auth.uid();
  else
    if new.version is distinct from old.version + 1 then
      raise exception 'version must increase by exactly 1 (stale write rejected)' using errcode = 'P0001';
    end if;
    new.user_id := old.user_id;       -- ownership can never change
    new.created_at := old.created_at;
  end if;
  new.server_updated_at := clock_timestamp();
  return new;
end $$;

-- Helper to declare the common sync columns for every table
-- (kept inline below for readability in the dashboard).

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------
create table if not exists public.business_profiles (
  id text primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null,
  legal_name text, email text, phone text, website text, address text, tax_id text,
  logo_data_url text,
  default_currency text not null default 'USD',
  default_tax_rate_bp integer not null default 0 check (default_tax_rate_bp between 0 and 100000),
  payment_details text,
  invoice_prefix text not null default 'INV-',
  quote_prefix text not null default 'QUO-',
  next_invoice_seq integer not null default 1,
  next_quote_seq integer not null default 1,
  created_at text not null, updated_at text not null, deleted_at text,
  version integer not null,
  server_updated_at timestamptz not null default now()
);

create table if not exists public.tax_rates (
  id text primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null,
  rate_bp integer not null check (rate_bp between 0 and 100000),
  is_default integer not null default 0,
  created_at text not null, updated_at text not null, deleted_at text,
  version integer not null,
  server_updated_at timestamptz not null default now()
);

create table if not exists public.customers (
  id text primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  code text, name text not null, email text, phone text, address text, tax_id text, notes text,
  archived_at text,
  created_at text not null, updated_at text not null, deleted_at text,
  version integer not null,
  server_updated_at timestamptz not null default now()
);

create table if not exists public.products (
  id text primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  sku text, name text not null, description text, category text,
  kind text not null default 'product' check (kind in ('product','service')),
  unit text not null default 'pcs',
  unit_price_minor bigint not null default 0 check (unit_price_minor >= 0),
  currency text not null default 'USD',
  tax_rate_bp integer not null default 0,
  is_active integer not null default 1,
  created_at text not null, updated_at text not null, deleted_at text,
  version integer not null,
  server_updated_at timestamptz not null default now()
);

create table if not exists public.quotations (
  id text primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  number text not null,
  customer_id text references public.customers(id) deferrable initially deferred,
  customer_snapshot text,
  issue_date text not null, expiry_date text,
  currency text not null,
  status text not null check (status in ('draft','sent','accepted','rejected','expired')),
  subtotal_minor bigint not null default 0, discount_minor bigint not null default 0,
  tax_minor bigint not null default 0, total_minor bigint not null default 0,
  notes text, terms text, converted_invoice_id text,
  created_at text not null, updated_at text not null, deleted_at text,
  version integer not null,
  server_updated_at timestamptz not null default now()
);

create table if not exists public.quotation_items (
  id text primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  quotation_id text not null references public.quotations(id) deferrable initially deferred,
  product_id text,
  position integer not null default 0,
  description text not null, unit text,
  quantity_milli bigint not null check (quantity_milli > 0),
  unit_price_minor bigint not null check (unit_price_minor >= 0),
  discount_type text not null default 'none' check (discount_type in ('none','percent','amount')),
  discount_value bigint not null default 0,
  tax_rate_bp integer not null default 0,
  line_subtotal_minor bigint not null, line_discount_minor bigint not null,
  line_tax_minor bigint not null, line_total_minor bigint not null,
  created_at text not null, updated_at text not null, deleted_at text,
  version integer not null,
  server_updated_at timestamptz not null default now()
);

create table if not exists public.invoices (
  id text primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  number text not null,
  customer_id text references public.customers(id) deferrable initially deferred,
  customer_snapshot text,
  issue_date text not null, due_date text,
  currency text not null,
  status text not null check (status in ('draft','pending','partially_paid','paid','overdue','cancelled')),
  subtotal_minor bigint not null default 0, discount_minor bigint not null default 0,
  tax_minor bigint not null default 0, total_minor bigint not null default 0,
  paid_minor bigint not null default 0,
  notes text, terms text,
  quotation_id text references public.quotations(id) deferrable initially deferred,
  created_at text not null, updated_at text not null, deleted_at text,
  version integer not null,
  server_updated_at timestamptz not null default now()
);

create table if not exists public.invoice_items (
  id text primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  invoice_id text not null references public.invoices(id) deferrable initially deferred,
  product_id text,
  position integer not null default 0,
  description text not null, unit text,
  quantity_milli bigint not null check (quantity_milli > 0),
  unit_price_minor bigint not null check (unit_price_minor >= 0),
  discount_type text not null default 'none' check (discount_type in ('none','percent','amount')),
  discount_value bigint not null default 0,
  tax_rate_bp integer not null default 0,
  line_subtotal_minor bigint not null, line_discount_minor bigint not null,
  line_tax_minor bigint not null, line_total_minor bigint not null,
  created_at text not null, updated_at text not null, deleted_at text,
  version integer not null,
  server_updated_at timestamptz not null default now()
);

create table if not exists public.payments (
  id text primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  invoice_id text not null references public.invoices(id) deferrable initially deferred,
  amount_minor bigint not null check (amount_minor > 0),
  paid_at text not null, method text, reference text, note text,
  created_at text not null, updated_at text not null, deleted_at text,
  version integer not null,
  server_updated_at timestamptz not null default now()
);

create table if not exists public.expenses (
  id text primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  category text, description text not null, vendor text,
  amount_minor bigint not null check (amount_minor > 0),
  currency text not null, spent_at text not null,
  created_at text not null, updated_at text not null, deleted_at text,
  version integer not null,
  server_updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Indexes, uniqueness, triggers and RLS for every table
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['business_profiles','tax_rates','customers','products','quotations',
                           'quotation_items','invoices','invoice_items','payments','expenses']
  loop
    execute format('create index if not exists %I on public.%I (user_id, server_updated_at, id)', 'ix_'||t||'_sync', t);
    execute format('drop trigger if exists lx_before_write on public.%I', t);
    execute format('create trigger lx_before_write before insert or update on public.%I
                    for each row execute function public.lx_before_write()', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('drop policy if exists "own rows: select" on public.%I', t);
    execute format('drop policy if exists "own rows: insert" on public.%I', t);
    execute format('drop policy if exists "own rows: update" on public.%I', t);
    execute format('create policy "own rows: select" on public.%I for select to authenticated using (user_id = auth.uid())', t);
    execute format('create policy "own rows: insert" on public.%I for insert to authenticated with check (user_id = auth.uid())', t);
    execute format('create policy "own rows: update" on public.%I for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid())', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select, insert, update on public.%I to authenticated', t);
  end loop;
end $$;

create unique index if not exists ux_invoices_number on public.invoices (user_id, number) where deleted_at is null;
create unique index if not exists ux_quotations_number on public.quotations (user_id, number) where deleted_at is null;
create index if not exists ix_invoice_items_invoice on public.invoice_items (invoice_id);
create index if not exists ix_quotation_items_quotation on public.quotation_items (quotation_id);
create index if not exists ix_payments_invoice on public.payments (invoice_id);

-- Children may only reference parents owned by the same user.
create or replace function public.lx_check_parent_owner() returns trigger
language plpgsql security definer set search_path = public as $$
declare parent_table text := tg_argv[0]; parent_col text := tg_argv[1]; parent_id text; owner uuid;
begin
  execute format('select ($1).%I', parent_col) using new into parent_id;
  if parent_id is null then return new; end if;
  execute format('select user_id from public.%I where id = $1', parent_table) using parent_id into owner;
  if owner is not null and owner <> new.user_id then
    raise exception 'cross-account reference rejected' using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists lx_owner_invoice_items on public.invoice_items;
create trigger lx_owner_invoice_items before insert or update on public.invoice_items
  for each row execute function public.lx_check_parent_owner('invoices', 'invoice_id');
drop trigger if exists lx_owner_quotation_items on public.quotation_items;
create trigger lx_owner_quotation_items before insert or update on public.quotation_items
  for each row execute function public.lx_check_parent_owner('quotations', 'quotation_id');
drop trigger if exists lx_owner_payments on public.payments;
create trigger lx_owner_payments before insert or update on public.payments
  for each row execute function public.lx_check_parent_owner('invoices', 'invoice_id');
drop trigger if exists lx_owner_invoices on public.invoices;
create trigger lx_owner_invoices before insert or update on public.invoices
  for each row execute function public.lx_check_parent_owner('customers', 'customer_id');
drop trigger if exists lx_owner_quotations on public.quotations;
create trigger lx_owner_quotations before insert or update on public.quotations
  for each row execute function public.lx_check_parent_owner('customers', 'customer_id');
