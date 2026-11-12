-- ============================================================================
-- Migration for the new Approval tracker version
--   1. UOM column on ims_requests and ims_qty_master
--   2. "PO making" stage (poMaking) is merged into "PO Preparation Stage" (poEntry):
--        PO No and Advance Payment Required now live on poEntry, and the stage
--        order is  ... PO Rate -> PO Preparation -> Rate Approval -> Advance Payment -> Delivery ...
-- Run ONCE in the Supabase SQL Editor on the existing database. Safe to run again.
-- (A brand-new database does not need it: schema.sql already has the new shape.)
-- ============================================================================

alter table ims_qty_master add column if not exists uom text not null default '';
alter table ims_requests   add column if not exists uom text not null default '';

-- Fill UOM of existing requests from the matching Material Quantity Master row (Planned ones only).
update ims_requests r
   set uom = q.uom
  from (select distinct on (project, construction_type, block, lot, material_name)
               project, construction_type, block, lot, material_name, uom
          from ims_qty_master where uom <> ''
         order by project, construction_type, block, lot, material_name, dup_no, id) q
 where r.uom = '' and r.planned = 'Planned'
   and q.project = r.project and q.construction_type = r.construction_type and q.block = r.block
   and q.lot = r.lot and q.material_name = r.material_name;

-- Move PO No / Advance Payment Required from poMaking onto poEntry.
update ims_request_stages e
   set extras = e.extras || jsonb_strip_nulls(jsonb_build_object(
         'poNo', m.extras -> 'poNo',
         'advancePaymentRequired', m.extras -> 'advancePaymentRequired'))
  from ims_request_stages m
 where m.sr_no = e.sr_no and m.stage_key = 'poMaking' and e.stage_key = 'poEntry';

-- poEntry now needs those fields as well: it stays Approved only if the old PO making was Approved too.
update ims_request_stages e
   set status = 'Not Approved', actual_at = null, delay_days = null, approved_by = ''
  from ims_request_stages m
 where m.sr_no = e.sr_no and m.stage_key = 'poMaking' and e.stage_key = 'poEntry'
   and e.status = 'Approved' and m.status <> 'Approved';

-- A request whose poMaking row exists but has no poEntry row yet (drafts started earlier): carry the row over.
insert into ims_request_stages (sr_no, stage_key, approver, planned_at, status, extras)
select m.sr_no, 'poEntry', m.approver, m.planned_at, m.status, m.extras
  from ims_request_stages m
 where m.stage_key = 'poMaking'
   and not exists (select 1 from ims_request_stages e where e.sr_no = m.sr_no and e.stage_key = 'poEntry');

delete from ims_request_stages where stage_key = 'poMaking';
delete from ims_stage_config   where stage_key = 'poMaking';
update ims_access_control
   set stage_keys = replace(replace(stage_keys, 'poMaking', 'poEntry'), 'PO making Stage', 'PO Preparation Stage')
 where stage_keys ilike '%poMaking%' or stage_keys ilike '%PO making Stage%';

-- Make the sheet mirror pick everything up again on the next pull.
update ims_requests  set updated_at = now();
update ims_qty_master set updated_at = now();

notify pgrst, 'reload schema';
