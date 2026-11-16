-- ============================================================================
-- IMS Purchase Approval Tracker - Supabase / PostgreSQL schema
--
-- Run this whole file once in the Supabase SQL Editor.
-- It is safe to run again: every statement uses "if not exists" / "or replace".
--
-- Notes
--   * All tables are prefixed with "ims_" so they can live next to other projects
--     in the same Supabase database.
--   * Row Level Security is enabled with NO policies. The anon / authenticated
--     keys therefore cannot read or write anything. The Python server connects
--     with the database connection string (table owner) and the Apps Script sync
--     uses the service_role key, both of which bypass RLS.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Master data (synced from the Google Sheet tabs)
-- ---------------------------------------------------------------------------

-- Sheet tab: People  (Name -> Email lookup used to resolve approvers)
create table if not exists ims_people (
  id    bigserial primary key,
  name  text not null,
  email text not null default ''
);
create unique index if not exists ims_people_name_key on ims_people (lower(name));

-- Sheet tab: Vendor Master
create table if not exists ims_vendors (
  name     text primary key,
  added_on timestamptz not null default now()
);

-- Sheet tab: Material Master
create table if not exists ims_materials (
  name     text primary key,
  added_on timestamptz not null default now()
);

-- Sheet tab: Stage Config  (one row per stage + project -> approver name)
create table if not exists ims_stage_config (
  stage_key text not null,
  project   text not null,
  approver  text not null default '',
  primary key (stage_key, project)
);

-- Sheet tab: Access Control. Kept exactly like the sheet (comma separated text)
-- so the same parsing logic as the Apps Script version can be reused.
create table if not exists ims_access_control (
  id          bigserial primary key,
  sort_order  integer not null default 0,
  access_types text not null default '',
  projects     text not null default '',
  stage_keys   text not null default '',
  notes        text not null default '',
  names_emails text not null default ''
);

-- Sheet tab: Material Quantity Master (BOQ quantities).
-- The same Project + Construction Type + Block + LOT + Material Name combination
-- can appear more than once in the sheet, so dup_no (1, 2, 3 ...) numbers the
-- repeats in sheet order. The first row (dup_no = 1) is the one the app deducts
-- from, exactly like the Apps Script version which used the first match.
create table if not exists ims_qty_master (
  id                bigserial primary key,
  material_status   text not null default '',
  construction_type text not null default '',
  block             text not null default '',
  lot               text not null default '',
  material_name     text not null default '',
  uom               text not null default '',
  total_qty         numeric,
  remaining         numeric,
  project           text not null default '',
  dup_no            integer not null default 1
);
create unique index if not exists ims_qty_master_combo_key
  on ims_qty_master (project, construction_type, block, lot, material_name, dup_no);
create index if not exists ims_qty_master_project_idx on ims_qty_master (project, id);

-- ---------------------------------------------------------------------------
-- Transaction data (written by the web app)
-- ---------------------------------------------------------------------------

-- Replaces the 98-column "Approval Tracker" sheet: one row per purchase request.
create table if not exists ims_requests (
  sr_no                 integer generated always as identity primary key,
  project               text not null,
  planned               text not null default 'Non Planned',
  construction_type     text not null default '',
  block                 text not null default '',
  lot                   text not null default '',
  material_name         text not null,
  material_type         text not null,
  task_name             text not null default '',
  point_of_uses         text not null default '',
  uom                   text not null default '',
  quantity              numeric not null,
  estimated_delivery_date date,
  status                text not null default 'Not Done',
  entry_status          text not null default 'Not Done',
  cancelled             boolean not null default false,
  cancelled_by          text not null default '',
  cancelled_at          timestamptz,
  cancel_reason         text not null default '',
  user_email            text not null,
  remarks               text not null default '',
  entry_timestamp       timestamptz not null default now()
);
create index if not exists ims_requests_project_idx on ims_requests (project);

-- One row per request per stage (the stage columns of the old wide sheet).
-- extras holds the stage specific fields, for example
--   indent       -> {"indentNo": "..."}
--   poEntry      -> {"vendorName": "...", "poAmount": 12000, "poNo": "...", "advancePaymentRequired": "Yes"}
--   delivery     -> {"challanBillNo": "..."}
create table if not exists ims_request_stages (
  sr_no       integer not null references ims_requests (sr_no) on delete cascade,
  stage_key   text not null,
  approver    text not null default '',
  planned_at  timestamptz,
  actual_at   timestamptz,
  delay_days  integer,
  status      text not null,
  approved_by text not null default '',
  extras      jsonb not null default '{}'::jsonb,
  primary key (sr_no, stage_key)
);

-- ---------------------------------------------------------------------------
-- Row Level Security: enabled, no policies (server side access only)
-- ---------------------------------------------------------------------------
alter table ims_people          enable row level security;
alter table ims_vendors         enable row level security;
alter table ims_materials       enable row level security;
alter table ims_stage_config    enable row level security;
alter table ims_access_control  enable row level security;
alter table ims_qty_master      enable row level security;
alter table ims_requests        enable row level security;
alter table ims_request_stages  enable row level security;

-- ---------------------------------------------------------------------------
-- ims_sync_masters(p, overwrite_remaining)
--
-- One function used by BOTH the one-time Python importer and the ongoing Google
-- Apps Script sync, so the two paths always behave the same.
--
-- p is a JSON object; every key is optional:
--   people         [{name, email}]
--   vendors        ["Vendor A", ...]
--   materials      ["Material A", ...]
--   stage_config   [{stage_key, project, approver}]
--   access_control [{access_types, projects, stage_keys, notes, names_emails}]
--   qty_master     [{material_status, construction_type, block, lot,
--                    material_name, uom, total_qty, remaining, project, dup_no}]
--
-- Rules
--   * people, stage_config      : upsert (the sheet value wins)
--   * vendors, materials        : insert new names only (nothing is ever deleted)
--   * access_control            : full replace (the sheet is the source of truth)
--   * qty_master                : upsert by combination + dup_no. Remaining is NOT
--                                 overwritten for existing rows, because the app
--                                 deducts from it. Pass overwrite_remaining = true
--                                 to force the sheet value.
-- ---------------------------------------------------------------------------
create or replace function ims_sync_masters(p jsonb, overwrite_remaining boolean default false)
returns jsonb
language plpgsql
as $$
declare
  n_people    integer := 0;
  n_vendors   integer := 0;
  n_materials integer := 0;
  n_stage     integer := 0;
  n_access    integer := 0;
  n_qty       integer := 0;
begin
  if p ? 'people' then
    insert into ims_people (name, email)
    select distinct on (lower(btrim(x ->> 'name')))
           btrim(x ->> 'name'),
           lower(btrim(coalesce(x ->> 'email', '')))
    from jsonb_array_elements(p -> 'people') as x
    where btrim(coalesce(x ->> 'name', '')) <> ''
    order by lower(btrim(x ->> 'name'))
    on conflict (lower(name)) do update set email = excluded.email;
    get diagnostics n_people = row_count;
  end if;

  if p ? 'vendors' then
    insert into ims_vendors (name)
    select distinct btrim(v)
    from jsonb_array_elements_text(p -> 'vendors') as v
    where btrim(v) <> ''
    on conflict (name) do nothing;
    get diagnostics n_vendors = row_count;
  end if;

  if p ? 'materials' then
    insert into ims_materials (name)
    select distinct btrim(v)
    from jsonb_array_elements_text(p -> 'materials') as v
    where btrim(v) <> ''
    on conflict (name) do nothing;
    get diagnostics n_materials = row_count;
  end if;

  if p ? 'stage_config' then
    insert into ims_stage_config (stage_key, project, approver)
    select distinct on (x ->> 'stage_key', x ->> 'project')
           x ->> 'stage_key',
           x ->> 'project',
           btrim(coalesce(x ->> 'approver', ''))
    from jsonb_array_elements(p -> 'stage_config') as x
    where coalesce(x ->> 'stage_key', '') <> '' and coalesce(x ->> 'project', '') <> ''
    order by x ->> 'stage_key', x ->> 'project'
    on conflict (stage_key, project) do update set approver = excluded.approver;
    get diagnostics n_stage = row_count;
  end if;

  if p ? 'access_control' then
    delete from ims_access_control where true;
    insert into ims_access_control (sort_order, access_types, projects, stage_keys, notes, names_emails)
    select t.ord::integer,
           coalesce(t.x ->> 'access_types', ''),
           coalesce(t.x ->> 'projects', ''),
           coalesce(t.x ->> 'stage_keys', ''),
           coalesce(t.x ->> 'notes', ''),
           coalesce(t.x ->> 'names_emails', '')
    from jsonb_array_elements(p -> 'access_control') with ordinality as t(x, ord);
    get diagnostics n_access = row_count;
  end if;

  if p ? 'qty_master' then
    insert into ims_qty_master
      (material_status, construction_type, block, lot, material_name, uom,
       total_qty, remaining, project, dup_no)
    select coalesce(t.x ->> 'material_status', ''),
           coalesce(t.x ->> 'construction_type', ''),
           coalesce(t.x ->> 'block', ''),
           coalesce(t.x ->> 'lot', ''),
           coalesce(t.x ->> 'material_name', ''),
           coalesce(t.x ->> 'uom', ''),
           nullif(t.x ->> 'total_qty', '')::numeric,
           nullif(t.x ->> 'remaining', '')::numeric,
           coalesce(t.x ->> 'project', ''),
           coalesce(nullif(t.x ->> 'dup_no', '')::integer, 1)
    from jsonb_array_elements(p -> 'qty_master') with ordinality as t(x, ord)
    order by t.ord
    on conflict (project, construction_type, block, lot, material_name, dup_no)
    do update set
      material_status = excluded.material_status,
      uom             = excluded.uom,
      total_qty       = excluded.total_qty,
      remaining       = case when overwrite_remaining then excluded.remaining
                             else ims_qty_master.remaining end;
    get diagnostics n_qty = row_count;
  end if;

  return jsonb_build_object(
    'people', n_people, 'vendors', n_vendors, 'materials', n_materials,
    'stage_config', n_stage, 'access_control', n_access, 'qty_master', n_qty
  );
end;
$$;

-- Only the service_role key (and the table owner) may call the sync function.
revoke all on function ims_sync_masters(jsonb, boolean) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function ims_sync_masters(jsonb, boolean) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function ims_sync_masters(jsonb, boolean) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function ims_sync_masters(jsonb, boolean) to service_role;
  end if;
end;
$$;
