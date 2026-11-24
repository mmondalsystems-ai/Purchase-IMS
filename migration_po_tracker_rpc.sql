-- RPC used by the "PO Tracker" sheet tab (one PO = one row). Read only. Run after migration_po_flow.sql.
create or replace function ims_po_tracker() returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(row_data order by po_id), '[]'::jsonb) from (
    select p.po_id, jsonb_build_object(
      'poId', p.po_id, 'poNo', p.po_no, 'project', p.project, 'supplier', p.vendor_name,
      'indentNos', coalesce((select string_agg(distinct s.extras->>'indentNo', ', ') from ims_po_items i
                             join ims_request_stages s on s.sr_no = i.sr_no and s.stage_key = 'indent'
                             where i.po_id = p.po_id and coalesce(s.extras->>'indentNo','') <> ''), ''),
      'materials', coalesce((select string_agg(r.material_name || ' (' || trim(trailing '.' from trim(trailing '0' from r.quantity::text)) || ' ' || r.uom || ')', '; ' order by r.sr_no)
                             from ims_po_items i join ims_requests r on r.sr_no = i.sr_no where i.po_id = p.po_id), ''),
      'poAmount', p.po_amount, 'advance', p.advance_required,
      'status', case when p.cancelled then 'Cancelled' else p.status end,
      'cancelReason', p.cancel_reason,
      'createdAt', to_char(p.created_at at time zone 'Asia/Kolkata', 'DD-Mon-YYYY HH12:MI AM'),
      'cancelledAt', coalesce(to_char(p.cancelled_at at time zone 'Asia/Kolkata', 'DD-Mon-YYYY HH12:MI AM'), ''),
      'stages', coalesce((select jsonb_object_agg(st.stage_key, jsonb_build_object(
          'planned', coalesce(to_char(st.planned_at at time zone 'Asia/Kolkata', 'DD-Mon-YYYY'), ''),
          'actual', coalesce(to_char(st.actual_at at time zone 'Asia/Kolkata', 'DD-Mon-YYYY HH12:MI AM'), ''),
          'status', st.status, 'delay', coalesce(st.delay_days::text, ''), 'approver', st.approver))
          from ims_po_stages st where st.po_id = p.po_id), '{}'::jsonb)
    ) as row_data
    from ims_purchase_orders p
  ) t;
$$;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function ims_po_tracker() to service_role;
  end if;
end $$;
