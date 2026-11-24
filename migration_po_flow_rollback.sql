-- Full rollback of the PO-level flow. The original tables (ims_requests, ims_request_stages) are never
-- modified by the PO flow except for mirrored stage values, so after this the app is exactly the old flow.
-- Fast switch (no data loss): update ims_settings set value = 'off' where key = 'po_flow_enabled';
drop table if exists ims_po_stages;
drop table if exists ims_po_items;
drop table if exists ims_purchase_orders;
drop table if exists ims_settings;
