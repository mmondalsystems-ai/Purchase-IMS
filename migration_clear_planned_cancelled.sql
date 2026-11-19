-- Clears every Planned date of requests that are already cancelled.
-- Run in the Supabase SQL Editor. Safe to run more than once.
-- Only planned_at is changed. Actual dates, delays, statuses and approvers stay as they are.
-- The updated_at trigger fires, so the next sheet pull (1 minute) blanks these cells.

-- STEP 1 (check): how many stage rows will change
select r.sr_no, s.stage_key, s.planned_at
from ims_requests r
join ims_request_stages s on s.sr_no = r.sr_no
where r.cancelled = true and s.planned_at is not null
order by r.sr_no, s.stage_key;

-- STEP 2 (run after checking STEP 1)
update ims_request_stages s
set planned_at = null
from ims_requests r
where r.sr_no = s.sr_no
  and r.cancelled = true
  and s.planned_at is not null;
