-- Advance Posting in Highrise Stage for OLD data.
-- Adds the stage to every existing, not-cancelled request whose PO Preparation Stage is Approved and
-- Advance Payment Required = Yes (any date). Planned date = the request's Rate Approval planned date.
-- Safe to run more than once (rows that already exist are left as they are). Nothing else is changed.
insert into ims_request_stages (sr_no, stage_key, approver, planned_at, status, extras)
select r.sr_no,
       'advancePosting',
       coalesce(sc.approver, ''),
       coalesce(
         ra.planned_at,
         -- fallback when Rate Approval has no planned date: PO Preparation actual date + 1 day (Sunday -> Monday)
         case when extract(dow from (po.actual_at at time zone 'Asia/Kolkata') + interval '1 day') = 0
              then po.actual_at + interval '2 days' else po.actual_at + interval '1 day' end
       ),
       'Not Approved',
       '{}'::jsonb
from ims_requests r
join ims_request_stages po on po.sr_no = r.sr_no and po.stage_key = 'poEntry'
left join ims_request_stages ra on ra.sr_no = r.sr_no and ra.stage_key = 'rateApproval'
left join ims_stage_config sc on sc.stage_key = 'advancePosting' and sc.project = r.project
where not coalesce(r.cancelled, false)
  and po.status = 'Approved'
  and po.extras->>'advancePaymentRequired' = 'Yes'
on conflict (sr_no, stage_key) do update
  set planned_at = excluded.planned_at
  where ims_request_stages.actual_at is null and ims_request_stages.planned_at is null;
