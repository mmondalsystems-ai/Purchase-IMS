-- ============================================================================
-- IMS Purchase Approval Tracker - live Google Sheet <-> Supabase sync
--
-- Run this whole file once in the Supabase SQL Editor, AFTER schema.sql.
-- It is safe to run again: every statement uses "if not exists" / "or replace".
--
-- What it adds
--   1. updated_at columns + triggers, so the sheet can ask "what changed since X".
--   2. ims_flat_request(sr_no)   one request as a flat JSON object, shaped like the
--                                old wide "Approval Tracker" sheet (one key per column).
--   3. ims_changes_since(...)    Supabase -> Sheet pull (used by the 1-minute trigger).
--   4. ims_push_row(...)         Sheet -> Supabase push (used by the onEdit trigger).
--
-- Flat key names (these are the keys used in the SYNC_MAP tab of the sheet)
--   Request level : sr_no, project, planned, construction_type, block, lot,
--                   material_name, material_type, uom, quantity, estimated_delivery_date,
--                   status, entry_status, cancelled, cancelled_by, cancelled_at,
--                   cancel_reason, user_email, remarks, entry_timestamp
--   Stage level   : <stage_key>_approver, <stage_key>_planned_at, <stage_key>_actual_at,
--                   <stage_key>_delay_days, <stage_key>_status, <stage_key>_approved_by
--   Stage extras  : <stage_key>_<extra key>, for example indent_indentNo,
--                   poEntry_vendorName, poEntry_poAmount, poEntry_poNo
--
-- Timestamps are exchanged as 'YYYY-MM-DD HH24:MI:SS' in Asia/Kolkata time.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. updated_at columns and triggers
-- ---------------------------------------------------------------------------
alter table ims_requests       add column if not exists updated_at timestamptz not null default now();
alter table ims_request_stages add column if not exists updated_at timestamptz not null default now();
alter table ims_qty_master     add column if not exists updated_at timestamptz not null default now();

create index if not exists ims_requests_updated_idx       on ims_requests (updated_at);
create index if not exists ims_request_stages_updated_idx on ims_request_stages (updated_at);
create index if not exists ims_qty_master_updated_idx     on ims_qty_master (updated_at);

create or replace function ims_touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Only bump updated_at when something really changed (the hourly master sync
-- rewrites rows with identical values and must not look like a change).
drop trigger if exists ims_requests_touch on ims_requests;
create trigger ims_requests_touch before update on ims_requests
  for each row when (old.* is distinct from new.*) execute function ims_touch_updated_at();

drop trigger if exists ims_request_stages_touch on ims_request_stages;
create trigger ims_request_stages_touch before update on ims_request_stages
  for each row when (old.* is distinct from new.*) execute function ims_touch_updated_at();

drop trigger if exists ims_qty_master_touch on ims_qty_master;
create trigger ims_qty_master_touch before update on ims_qty_master
  for each row when (old.* is distinct from new.*) execute function ims_touch_updated_at();

-- A stage change also marks its request as changed.
create or replace function ims_stage_bump_request() returns trigger
language plpgsql as $$
begin
  update ims_requests set updated_at = now() where sr_no = new.sr_no;
  return null;
end;
$$;

drop trigger if exists ims_request_stages_bump on ims_request_stages;
create trigger ims_request_stages_bump after insert or update on ims_request_stages
  for each row execute function ims_stage_bump_request();

-- ---------------------------------------------------------------------------
-- 2. One request as a flat JSON object
-- ---------------------------------------------------------------------------
create or replace function ims_flat_request(p_sr_no integer) returns jsonb
language sql stable as $$
  select jsonb_build_object(
           'sr_no', r.sr_no,
           'project', r.project,
           'planned', r.planned,
           'construction_type', r.construction_type,
           'block', r.block,
           'lot', r.lot,
           'material_name', r.material_name,
           'material_type', r.material_type,
           'uom', r.uom,
           'quantity', r.quantity,
           'estimated_delivery_date', to_char(r.estimated_delivery_date, 'YYYY-MM-DD'),
           'status', r.status,
           'entry_status', r.entry_status,
           'cancelled', r.cancelled,
           'cancelled_by', r.cancelled_by,
           'cancelled_at', to_char(r.cancelled_at at time zone 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI:SS'),
           'cancel_reason', r.cancel_reason,
           'user_email', r.user_email,
           'remarks', r.remarks,
           'entry_timestamp', to_char(r.entry_timestamp at time zone 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI:SS')
         )
         || coalesce((
              select jsonb_object_agg(x.k, x.v)
              from (
                select s.stage_key || '_approver' as k, to_jsonb(s.approver) as v
                  from ims_request_stages s where s.sr_no = r.sr_no
                union all
                select s.stage_key || '_planned_at',
                       to_jsonb(to_char(s.planned_at at time zone 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI:SS'))
                  from ims_request_stages s where s.sr_no = r.sr_no
                union all
                select s.stage_key || '_actual_at',
                       to_jsonb(to_char(s.actual_at at time zone 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI:SS'))
                  from ims_request_stages s where s.sr_no = r.sr_no
                union all
                select s.stage_key || '_delay_days', to_jsonb(s.delay_days)
                  from ims_request_stages s where s.sr_no = r.sr_no
                union all
                select s.stage_key || '_status', to_jsonb(s.status)
                  from ims_request_stages s where s.sr_no = r.sr_no
                union all
                select s.stage_key || '_approved_by', to_jsonb(s.approved_by)
                  from ims_request_stages s where s.sr_no = r.sr_no
                union all
                select s.stage_key || '_' || e.key, e.value
                  from ims_request_stages s, jsonb_each(s.extras) e where s.sr_no = r.sr_no
              ) x
            ), '{}'::jsonb)
  from ims_requests r
  where r.sr_no = p_sr_no;
$$;

-- ---------------------------------------------------------------------------
-- 3. Supabase -> Sheet: everything that changed since a point in time
--
--   p_since NULL  = full pull, paged by Sr No (p_after_sr / p_limit)
--   p_since given = incremental pull; a 30 second overlap is included on purpose
--                   (the sheet writer is idempotent, so repeats are harmless)
--
-- Returns { now, requests: [flat objects], qty: [Remaining values] }.
-- Store "now" as the next p_since (pass the string back unchanged).
-- ---------------------------------------------------------------------------
create or replace function ims_changes_since(
  p_since    timestamptz default null,
  p_after_sr integer     default 0,
  p_limit    integer     default 200
) returns jsonb
language plpgsql as $$
declare
  v_now   timestamptz := now();
  v_since timestamptz := p_since - interval '30 seconds';
  v_reqs  jsonb;
  v_qty   jsonb := '[]'::jsonb;
begin
  if p_since is null then
    select coalesce(jsonb_agg(ims_flat_request(t.sr_no) order by t.sr_no), '[]'::jsonb)
      into v_reqs
      from (select sr_no from ims_requests where sr_no > p_after_sr order by sr_no limit p_limit) t;
  else
    select coalesce(jsonb_agg(ims_flat_request(t.sr_no) order by t.sr_no), '[]'::jsonb)
      into v_reqs
      from (select sr_no from ims_requests where updated_at > v_since order by sr_no) t;
  end if;

  if p_since is not null or p_after_sr = 0 then
    select coalesce(jsonb_agg(jsonb_build_object(
             'project', q.project,
             'construction_type', q.construction_type,
             'block', q.block,
             'lot', q.lot,
             'material_name', q.material_name,
             'dup_no', q.dup_no,
             'total_qty', q.total_qty,
             'remaining', q.remaining
           ) order by q.id), '[]'::jsonb)
      into v_qty
      from ims_qty_master q
      where p_since is null or q.updated_at > v_since;
  end if;

  return jsonb_build_object('now', v_now, 'requests', v_reqs, 'qty', v_qty);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Sheet -> Supabase: apply the edited cells of one request
--
--   p_changes is a flat object { key: value } containing ONLY the edited cells.
--   Each key is applied on its own (a bad value does not block the others).
--   Changing "quantity" of a Planned, not cancelled request also moves the
--   Remaining of the matching Material Quantity Master row by the difference,
--   and is rejected if Remaining would go below zero.
--   Stage columns are plain data corrections: they do NOT start or advance the
--   workflow (use the web app for approvals).
--
-- Returns { ok, applied: [keys], errors: [{key, message}] }.
-- ---------------------------------------------------------------------------
create or replace function ims_push_row(p_sr_no integer, p_changes jsonb) returns jsonb
language plpgsql as $$
declare
  c_req_cols  constant text[] := array[
    'project','planned','construction_type','block','lot','material_name','material_type','uom',
    'quantity','estimated_delivery_date','status','entry_status','cancelled','cancelled_by',
    'cancelled_at','cancel_reason','user_email','remarks','entry_timestamp'];
  c_nontext   constant text[] := array[
    'quantity','estimated_delivery_date','cancelled','cancelled_at','entry_timestamp'];
  c_stage_ts  constant text[] := array['planned_at','actual_at'];
  c_stage_txt constant text[] := array['approver','approved_by','status'];

  v_req        ims_requests%rowtype;
  v_stage_keys text[];
  v_applied    text[] := '{}';
  v_errors     jsonb := '[]'::jsonb;
  k            text;
  v            jsonb;
  val          text;
  v_sk         text;
  v_field      text;
  v_matched    boolean;
  v_new_qty    numeric;
  v_q          record;
begin
  -- Timestamps typed in the sheet are Kolkata time.
  perform set_config('timezone', 'Asia/Kolkata', true);

  select * into v_req from ims_requests where sr_no = p_sr_no for update;
  if not found then
    return jsonb_build_object('ok', false, 'applied', '[]'::jsonb,
      'errors', jsonb_build_array(jsonb_build_object('key', 'sr_no',
        'message', 'Sr No ' || p_sr_no || ' was not found in Supabase.')));
  end if;

  select coalesce(array_agg(distinct stage_key), '{}') into v_stage_keys
    from ims_request_stages where sr_no = p_sr_no;

  for k, v in select key, value from jsonb_each(coalesce(p_changes, '{}'::jsonb)) loop
    begin
      val := case when jsonb_typeof(v) = 'null' then null else v #>> '{}' end;
      v_matched := false;

      -- ---- request level ----
      if k = any (c_req_cols) then
        v_matched := true;
        if val is null and not (k = any (c_nontext)) then val := ''; end if;
        if val = '' and k = any (c_nontext) then val := null; end if;

        if k = 'quantity' then
          if val is null then raise exception 'Quantity cannot be empty.'; end if;
          v_new_qty := val::numeric;
          if v_req.planned = 'Planned' and not v_req.cancelled then
            select id, remaining into v_q
              from ims_qty_master
             where project = v_req.project and construction_type = v_req.construction_type
               and block = v_req.block and lot = v_req.lot and material_name = v_req.material_name
             order by dup_no, id limit 1 for update;
            if found then
              if coalesce(v_q.remaining, 0) - (v_new_qty - v_req.quantity) < 0 then
                raise exception 'Quantity % is more than the Remaining % in Material Quantity Master.',
                  v_new_qty, coalesce(v_q.remaining, 0);
              end if;
              update ims_qty_master
                 set remaining = coalesce(remaining, 0) - (v_new_qty - v_req.quantity)
               where id = v_q.id;
            end if;
          end if;
          v_req.quantity := v_new_qty;
        end if;

        execute format(
          'update ims_requests set %I = (jsonb_populate_record(null::ims_requests, jsonb_build_object(%L, %L::text))).%I where sr_no = %s',
          k, k, val, k, p_sr_no);
      end if;

      -- ---- stage level ----
      if not v_matched then
        foreach v_sk in array v_stage_keys loop
          if left(k, length(v_sk) + 1) = v_sk || '_' then
            v_field := substr(k, length(v_sk) + 2);
            v_matched := true;

            if v_field = any (c_stage_txt) then
              update ims_request_stages set
                approver    = case when v_field = 'approver'    then coalesce(val, '') else approver end,
                approved_by = case when v_field = 'approved_by' then coalesce(val, '') else approved_by end,
                status      = case when v_field = 'status'      then coalesce(val, '') else status end
               where sr_no = p_sr_no and stage_key = v_sk;
            elsif v_field = any (c_stage_ts) then
              if val = '' then val := null; end if;
              update ims_request_stages set
                planned_at = case when v_field = 'planned_at' then val::timestamptz else planned_at end,
                actual_at  = case when v_field = 'actual_at'  then val::timestamptz else actual_at end
               where sr_no = p_sr_no and stage_key = v_sk;
            elsif v_field = 'delay_days' then
              if val = '' then val := null; end if;
              update ims_request_stages set delay_days = val::integer
               where sr_no = p_sr_no and stage_key = v_sk;
            else
              -- stage specific extra field (indentNo, vendorName, poAmount, poNo, ...)
              update ims_request_stages
                 set extras = jsonb_set(
                       extras, array[v_field],
                       case
                         when v_field = 'poAmount' and val ~ '^-?[0-9]+(\.[0-9]+)?$' then to_jsonb(val::numeric)
                         else to_jsonb(coalesce(val, ''))
                       end,
                       true)
               where sr_no = p_sr_no and stage_key = v_sk;
            end if;
            exit;
          end if;
        end loop;
      end if;

      if not v_matched then
        raise exception 'Unknown column key "%".', k;
      end if;

      v_applied := v_applied || k;
    exception when others then
      v_errors := v_errors || jsonb_build_object('key', k, 'message', sqlerrm);
    end;
  end loop;

  return jsonb_build_object('ok', jsonb_array_length(v_errors) = 0,
                            'applied', to_jsonb(v_applied), 'errors', v_errors);
end;
$$;

-- ---------------------------------------------------------------------------
-- Only the service_role key (used by Apps Script) may call these functions.
-- ---------------------------------------------------------------------------
revoke all on function ims_flat_request(integer) from public;
revoke all on function ims_changes_since(timestamptz, integer, integer) from public;
revoke all on function ims_push_row(integer, jsonb) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function ims_flat_request(integer) from anon;
    revoke all on function ims_changes_since(timestamptz, integer, integer) from anon;
    revoke all on function ims_push_row(integer, jsonb) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function ims_flat_request(integer) from authenticated;
    revoke all on function ims_changes_since(timestamptz, integer, integer) from authenticated;
    revoke all on function ims_push_row(integer, jsonb) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function ims_flat_request(integer) to service_role;
    grant execute on function ims_changes_since(timestamptz, integer, integer) to service_role;
    grant execute on function ims_push_row(integer, jsonb) to service_role;
  end if;
end;
$$;
