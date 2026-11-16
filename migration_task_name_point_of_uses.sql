-- Adds Task Name and Point of Uses to purchase requests. Safe to run more than once.
alter table ims_requests add column if not exists task_name     text not null default '';
alter table ims_requests add column if not exists point_of_uses text not null default '';
notify pgrst, 'reload schema';
