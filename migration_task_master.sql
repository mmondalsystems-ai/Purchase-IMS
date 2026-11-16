-- Task Master: adds the ims_tasks table and teaches ims_sync_masters about the "tasks" list.
-- Safe to run more than once.
create table if not exists ims_tasks (
  name     text primary key,
  added_on timestamptz not null default now()
);
alter table ims_tasks enable row level security;

create or replace function ims_sync_masters(p jsonb, overwrite_remaining boolean default false)
returns jsonb
language plpgsql
as $$
declare
  n_people    integer := 0;
  n_vendors   integer := 0;
  n_materials integer := 0;
  n_tasks     integer := 0;
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

  if p ? 'tasks' then
    insert into ims_tasks (name)
    select distinct btrim(v)
    from jsonb_array_elements_text(p -> 'tasks') as v
    where btrim(v) <> ''
    on conflict (name) do nothing;
    get diagnostics n_tasks = row_count;
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
    'people', n_people, 'vendors', n_vendors, 'materials', n_materials, 'tasks', n_tasks,
    'stage_config', n_stage, 'access_control', n_access, 'qty_master', n_qty
  );
end;
$$;


notify pgrst, 'reload schema';
