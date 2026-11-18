-- Delay (days) becomes a decimal so that a few hours of delay is visible (1 hour late = -0.04).
-- Existing whole-number values are kept as they are (for example 0 becomes 0.00).
-- Run this FIRST, then re-run schema_sync.sql (its push function now writes decimals).
alter table ims_request_stages alter column delay_days type numeric(10,2);
notify pgrst, 'reload schema';
