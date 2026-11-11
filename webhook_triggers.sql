-- Instant Supabase -> Google Sheet signal.
-- Replace the URL below with your Apps Script web app URL including ?token=...
-- The request body is empty: no row data leaves the database, it is only a "pull now" ping.

create extension if not exists pg_net with schema extensions;

create or replace function public.ims_notify_sheet() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform net.http_post(
    url := 'PASTE_APPS_SCRIPT_EXEC_URL_WITH_TOKEN_HERE',
    body := '{}'::jsonb,
    headers := '{"Content-Type":"application/json"}'::jsonb,
    timeout_milliseconds := 5000
  );
  return null;
exception when others then
  return null; -- a failed ping must never block a user's save; the 1-minute trigger catches up
end $$;

revoke all on function public.ims_notify_sheet() from public, anon, authenticated;

drop trigger if exists ims_notify_requests on ims_requests;
create trigger ims_notify_requests after insert or update on ims_requests
  for each statement execute function public.ims_notify_sheet();

drop trigger if exists ims_notify_stages on ims_request_stages;
create trigger ims_notify_stages after insert or update on ims_request_stages
  for each statement execute function public.ims_notify_sheet();

drop trigger if exists ims_notify_qty on ims_qty_master;
create trigger ims_notify_qty after insert or update on ims_qty_master
  for each statement execute function public.ims_notify_sheet();
