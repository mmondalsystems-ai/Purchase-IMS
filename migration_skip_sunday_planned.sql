-- No planned date on a Sunday: existing Planned dates that fall on a Sunday move to Monday,
-- and every later stage of the same flow moves with them (the gaps between stages stay the same).
-- Run in the Supabase SQL Editor. Safe to run more than once (a second run changes nothing).
-- Cancelled requests are skipped. Actual dates are never changed; Delay is recalculated
-- (Planned - Actual, in days with 2 decimals) only for stages whose Planned date changed.
-- Sunday is checked in Asia/Kolkata time.

create or replace function ims_skip_sunday(ts timestamptz) returns timestamptz
language sql immutable as $$
  select case when extract(dow from ts at time zone 'Asia/Kolkata') = 0
              then ts + interval '1 day' else ts end;
$$;

-- STEP 1 (check): how many planned dates are on a Sunday right now
select r.sr_no, s.stage_key, s.planned_at at time zone 'Asia/Kolkata' as planned_kolkata
from ims_requests r
join ims_request_stages s on s.sr_no = r.sr_no
where r.cancelled = false
  and s.planned_at is not null
  and extract(dow from s.planned_at at time zone 'Asia/Kolkata') = 0
order by r.sr_no, s.stage_key;

-- STEP 2 (run after checking STEP 1)
do $$
declare
  stage record;
begin
  create temporary table tmp_stage_parent (ord int, stage_key text, parent_key text) on commit drop;
  insert into tmp_stage_parent values
    (1,  'approval',       null),
    (2,  'approval2',      'approval'),
    (3,  'wbs',            'approval2'),
    (4,  'indent',         'wbs'),
    (5,  'poRate',         'indent'),
    (6,  'poEntry',        'poRate'),
    (7,  'rateApproval',   'poEntry'),
    (8,  'advancePayment', 'rateApproval'),
    (9,  'delivery',       'poEntry'),
    (10, 'grn',            'delivery'),
    (11, 'truckEntry',     'grn');

  create temporary table tmp_plan (sr_no integer, stage_key text, old_p timestamptz, new_p timestamptz) on commit drop;

  -- Walk the stages in flow order so every stage already knows how far its parent moved.
  for stage in select * from tmp_stage_parent order by ord loop
    insert into tmp_plan (sr_no, stage_key, old_p, new_p)
    select s.sr_no, s.stage_key, s.planned_at,
           ims_skip_sunday(s.planned_at + coalesce(pp.new_p - pp.old_p, interval '0'))
    from ims_request_stages s
    join ims_requests r on r.sr_no = s.sr_no and r.cancelled = false
    left join tmp_plan pp on pp.sr_no = s.sr_no and pp.stage_key = stage.parent_key
    where s.stage_key = stage.stage_key
      and s.planned_at is not null;
  end loop;

  update ims_request_stages s
  set planned_at = t.new_p,
      delay_days = case when s.actual_at is not null
                        then round((extract(epoch from (t.new_p - s.actual_at)) / 86400.0)::numeric, 2)
                        else s.delay_days end
  from tmp_plan t
  where t.sr_no = s.sr_no and t.stage_key = s.stage_key
    and t.new_p is distinct from t.old_p;
end $$;

-- STEP 3 (check): this must return no rows
select r.sr_no, s.stage_key, s.planned_at at time zone 'Asia/Kolkata' as planned_kolkata
from ims_requests r
join ims_request_stages s on s.sr_no = r.sr_no
where r.cancelled = false
  and s.planned_at is not null
  and extract(dow from s.planned_at at time zone 'Asia/Kolkata') = 0;
