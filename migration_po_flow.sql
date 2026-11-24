-- PO-level flow (Plan B): purely ADDITIVE. No existing table or row is changed.
-- The flow is OFF by default. To roll back completely, run migration_po_flow_rollback.sql (or just keep the flag OFF).

create table if not exists ims_settings (
  key   text primary key,
  value text not null default ''
);
insert into ims_settings (key, value) values ('po_flow_enabled', 'off') on conflict (key) do nothing;

create table if not exists ims_purchase_orders (
  po_id            integer generated always as identity primary key,
  po_no            text not null,
  project          text not null,
  material_type    text not null default '',
  vendor_name      text not null default '',
  po_amount        text not null default '',
  payment_terms    text not null default '',
  advance_required text not null default 'No',
  status           text not null default 'Not Done',
  created_by       text not null default '',
  created_at       timestamptz not null default now(),
  cancelled        boolean not null default false,
  cancelled_by     text not null default '',
  cancelled_at     timestamptz,
  cancel_reason    text not null default ''
);
create index if not exists ims_purchase_orders_po_no_idx on ims_purchase_orders (po_no);

create table if not exists ims_po_items (
  po_id integer not null references ims_purchase_orders (po_id) on delete cascade,
  sr_no integer not null references ims_requests (sr_no) on delete cascade,
  primary key (po_id, sr_no),
  unique (sr_no)
);

create table if not exists ims_po_stages (
  po_id       integer not null references ims_purchase_orders (po_id) on delete cascade,
  stage_key   text not null,
  approver    text not null default '',
  planned_at  timestamptz,
  actual_at   timestamptz,
  delay_days  numeric(10,2),
  status      text not null,
  approved_by text not null default '',
  extras      jsonb not null default '{}'::jsonb,
  primary key (po_id, stage_key)
);

alter table ims_settings        enable row level security;
alter table ims_purchase_orders enable row level security;
alter table ims_po_items        enable row level security;
alter table ims_po_stages       enable row level security;
