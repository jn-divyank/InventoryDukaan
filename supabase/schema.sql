-- Arpit Steel Centre — current database schema (project: arpit-steel-centre, ap-south-1)
--
-- This file is the readable source of truth for the schema. It was applied to
-- the live project as three migrations:
--   core_schema, rls_functions_views, harden_security_definer_functions
--
-- Design notes:
--   * Money is numeric(12,2). Never float.
--   * GST columns exist but stay null until the CA confirms rates and HSN codes,
--     so enabling GST is a data change, not a migration.
--   * Stock columns exist but track_stock defaults false; stock is phase 4.
--   * client_id on synced tables makes upserts from the offline client idempotent.
--   * Party balances are DERIVED from ledger_entries and are never a stored,
--     hand-editable number. This is what the old oldBal field got wrong.

create extension if not exists pgcrypto;
create schema if not exists private;   -- not exposed over the REST API

-- ============================================================ tenancy
create table public.stores (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null, address text, phone text, gstin text, upi_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.store_users (
  store_id uuid not null references public.stores(id) on delete cascade,
  user_id  uuid not null references auth.users(id) on delete cascade,
  role text not null default 'staff' check (role in ('owner','staff')),
  created_at timestamptz not null default now(),
  primary key (store_id, user_id)
);

-- ============================================================ master data
create table public.parties (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  client_id text,
  acc_no text, name text not null, phone text, gstin text,
  opening_balance numeric(12,2) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (store_id, client_id)
);

create table public.products (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  client_id text,
  name text not null,
  unit text not null default 'Pcs',
  mrp numeric(12,2) not null default 0,
  default_discount numeric(5,2) not null default 0,
  cost_price numeric(12,2),
  hsn_code text,                              -- GST
  gst_rate numeric(5,2),                      -- GST; null = unclassified
  stock_qty numeric(12,3) not null default 0, -- phase 4
  track_stock boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (store_id, client_id)
);

-- ============================================================ documents
create table public.documents (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  client_id text,
  doc_type text not null check (doc_type in ('SALE','PURCHASE')),
  doc_no text not null,
  party_id uuid references public.parties(id) on delete set null,
  party_text text,
  issued_at timestamptz not null default now(),
  pay_mode text not null default 'Cash' check (pay_mode in ('Cash','UPI','Credit','Split')),
  sum_mrp numeric(12,2) not null default 0,
  scrap_deduction numeric(12,2) not null default 0,
  extra_discount numeric(12,2) not null default 0,
  round_off numeric(12,2) not null default 0,
  grand_total numeric(12,2) not null default 0,
  split_paid numeric(12,2) not null default 0,
  taxable_value numeric(12,2), cgst numeric(12,2), sgst numeric(12,2), igst numeric(12,2),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  -- Database-level guarantee against the bill-number reuse that was silently
  -- overwriting sales in the localStorage-only version.
  unique (store_id, doc_type, doc_no),
  unique (store_id, client_id)
);

create table public.document_items (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  line_no int not null,
  product_id uuid references public.products(id) on delete set null,
  -- Snapshotted, not joined: editing the catalog must never retroactively
  -- change a bill already handed to a customer.
  name text not null,
  qty numeric(12,3) not null default 1,
  unit text not null default 'Pcs',
  mrp numeric(12,2) not null default 0,
  discount_pct numeric(5,2) not null default 0,
  total_mrp numeric(12,2) not null default 0,
  net_price numeric(12,2) not null default 0,
  hsn_code text, gst_rate numeric(5,2),
  taxable_value numeric(12,2), tax_amount numeric(12,2),
  warranty text,
  unique (document_id, line_no)
);

-- ============================================================ ledger
-- amount > 0: party owes the shop.   amount < 0: the shop owes the party.
create table public.ledger_entries (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  client_id text,
  party_id uuid not null references public.parties(id) on delete cascade,
  document_id uuid references public.documents(id) on delete cascade,
  entry_type text not null check (entry_type in ('OPENING','BILL','PAYMENT','ADJUSTMENT')),
  entry_date timestamptz not null default now(),
  amount numeric(12,2) not null,
  pay_method text, note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (store_id, client_id)
);
-- One BILL row per document, so a re-sync cannot double-post a credit sale.
create unique index ledger_one_bill_per_doc on public.ledger_entries(document_id)
  where entry_type = 'BILL' and deleted_at is null;

-- ============================================================ stock (phase 4)
create table public.stock_movements (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  document_id uuid references public.documents(id) on delete cascade,
  qty_delta numeric(12,3) not null,
  reason text not null check (reason in ('SALE','PURCHASE','ADJUSTMENT','OPENING')),
  moved_at timestamptz not null default now(),
  note text
);

-- ============================================================ numbering
create table public.doc_counters (
  store_id uuid not null references public.stores(id) on delete cascade,
  doc_type text not null check (doc_type in ('SALE','PURCHASE')),
  prefix text not null,
  next_no int not null default 1,
  primary key (store_id, doc_type)
);

-- Atomic allocation. The row lock plus unique(store_id,doc_type,doc_no) is what
-- makes it impossible for two devices to mint the same bill number.
create or replace function public.next_doc_no(p_store uuid, p_type text)
returns text language plpgsql security definer
set search_path = public, pg_temp as $$
declare v_prefix text; v_no int;
begin
  if not private.is_store_member(p_store) then
    raise exception 'not a member of this store';
  end if;
  insert into public.doc_counters (store_id, doc_type, prefix, next_no)
  values (p_store, p_type, case when p_type='SALE' then 'ASC-' else 'PUR-' end, 1)
  on conflict (store_id, doc_type) do nothing;
  update public.doc_counters set next_no = next_no + 1
   where store_id = p_store and doc_type = p_type
  returning prefix, next_no - 1 into v_prefix, v_no;
  return v_prefix || lpad(v_no::text, 3, '0');
end; $$;
revoke all on function public.next_doc_no(uuid,text) from public, anon;
grant execute on function public.next_doc_no(uuid,text) to authenticated;

-- ============================================================ access control
-- Lives in `private` so it is not reachable at /rest/v1/rpc; security definer
-- so policies can read store_users without recursing into its own policy.
create or replace function private.is_store_member(p_store uuid)
returns boolean language sql security definer
set search_path = public, pg_temp stable as $$
  select exists (select 1 from public.store_users su
                 where su.store_id = p_store and su.user_id = (select auth.uid()));
$$;
revoke all on function private.is_store_member(uuid) from public, anon;
grant execute on function private.is_store_member(uuid) to authenticated, service_role;

-- RLS is enabled on every table. Store-scoped tables use a single policy:
--   for all to authenticated
--   using (private.is_store_member(store_id))
--   with check (private.is_store_member(store_id))
-- document_items inherits access through its parent document.
-- stores/store_users are keyed on owner_id = auth.uid().

-- ============================================================ views
-- security_invoker so RLS on the underlying tables still applies.
create view public.party_balances with (security_invoker = true) as
select p.id as party_id, p.store_id, p.acc_no, p.name, p.phone, p.opening_balance,
       p.opening_balance + coalesce((select sum(l.amount) from public.ledger_entries l
                                     where l.party_id = p.id and l.deleted_at is null), 0) as balance
from public.parties p
where p.deleted_at is null;
