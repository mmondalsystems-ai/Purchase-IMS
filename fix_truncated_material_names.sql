-- STEP 1 (check only): Planned requests whose material name was cut at a double quote (")
-- and the full name found in ims_qty_master. Run this first and look at the result.
select r.sr_no, r.material_name as saved_name, q.material_name as full_name,
       r.quantity, q.remaining as remaining_now
from ims_requests r
join ims_qty_master q
  on q.project = r.project and q.construction_type = r.construction_type
 and q.block = r.block and q.lot = r.lot
 and q.material_name like r.material_name || '%'
 and q.material_name <> r.material_name
where r.planned = 'Planned' and not r.cancelled
order by r.sr_no;

-- STEP 2 (fix): restore the full name AND deduct the quantity that was never deducted.
-- Run only after STEP 1 looks right. Rows with several possible full names are skipped.
with cand as (
  select r.sr_no, r.quantity, q.id as qid, q.material_name as full_name,
         count(*) over (partition by r.sr_no) as n
  from ims_requests r
  join ims_qty_master q
    on q.project = r.project and q.construction_type = r.construction_type
   and q.block = r.block and q.lot = r.lot
   and q.material_name like r.material_name || '%'
   and q.material_name <> r.material_name
  where r.planned = 'Planned' and not r.cancelled
), fix as (
  select * from cand where n = 1
), upd_req as (
  update ims_requests r set material_name = f.full_name
  from fix f where r.sr_no = f.sr_no returning f.qid, f.quantity
)
update ims_qty_master q
set remaining = greatest(coalesce(q.remaining, 0) - u.s, 0)
from (select qid, sum(quantity) as s from upd_req group by qid) u
where q.id = u.qid;
