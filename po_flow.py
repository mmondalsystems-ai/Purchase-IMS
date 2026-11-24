"""
PO-level flow ("Plan B").

After PO Preparation the materials of one PO become ONE PO entity. Rate Approval, Advance Payment,
Delivery, GRN and Truck Entry run once on that PO. The result of every PO stage is mirrored to the
item rows (ims_request_stages), so existing pages, reports and the sheet sync keep working.

Everything here sits behind the `po_flow_enabled` setting (ims_settings). When it is OFF (the default,
or when the tables do not exist) none of this code changes any behavior: the original item-level flow runs.
"""
import datetime as dt
import logging

import config as cfg
import db
import logic
from logic import (UserError, _identity, _load_context, _num, db_json, delay_days_between, fmt_dt,
                   get_access_emails, get_approver_name, get_next_stage_key, get_prev_stage_key, now,
                   planned_after, resolve_email, status_values, STAGE_BY_KEY)

log = logging.getLogger("ims")

POST_PO_KEYS = ["rateApproval", "advancePayment", "delivery", "grn", "truckEntry"]


# ---------------------------------------------------------------------------
# Switch
# ---------------------------------------------------------------------------
def enabled() -> bool:
    """True only when the setting is 'on'. Any problem (for example the tables are missing) means OFF."""
    try:
        with db.connection() as conn:
            row = conn.execute("select value from ims_settings where key = 'po_flow_enabled'").fetchone()
        return bool(row) and str(row["value"]).strip().lower() == "on"
    except Exception:
        return False


def po_of_items(conn) -> dict:
    """{sr_no: {"poId": .., "poNo": ..}} for items that belong to a live (not cancelled) PO."""
    rows = conn.execute(
        "select i.sr_no, p.po_id, p.po_no from ims_po_items i join ims_purchase_orders p on p.po_id = i.po_id "
        "where not p.cancelled").fetchall()
    return {r["sr_no"]: {"poId": r["po_id"], "poNo": r["po_no"]} for r in rows}


def item_po(sr_no):
    """PO info of one item when the flow is ON and the item belongs to a live PO, else None."""
    if not enabled():
        return None
    with db.connection() as conn:
        return po_of_items(conn).get(int(sr_no))


# ---------------------------------------------------------------------------
# Planned dates and approvers
# ---------------------------------------------------------------------------
def _planned_map(base_po_entry_planned, base_fallback, adv_required):
    """Same gap logic as the item flow: Rate +1 after PO Preparation planned, Advance +1, Delivery =
    PO Preparation planned + 15, GRN +1, Truck Entry +1 (Sunday moves to Monday)."""
    base = base_po_entry_planned or base_fallback
    rate = planned_after(base, 1)
    out = {"rateApproval": rate}
    if adv_required == "Yes":
        out["advancePayment"] = planned_after(rate, 1)
    delivery = planned_after(base, 15)
    out["delivery"] = delivery
    grn = planned_after(delivery, 1)
    out["grn"] = grn
    out["truckEntry"] = planned_after(grn, 1)
    return out


def _po_stage_keys(adv_required):
    return [k for k in POST_PO_KEYS if k != "advancePayment" or adv_required == "Yes"]


def _approver_for(stage_key, project, material_type, amount, stage_cfg):
    return get_approver_name(stage_key, project, material_type, amount if stage_key == "rateApproval" else "", stage_cfg)


def _mirror_to_items(conn, sr_nos, stage_key, row, extras=None):
    """Copy one PO stage result to every item's ims_request_stages row."""
    for sr in sr_nos:
        if extras:
            old = conn.execute("select extras from ims_request_stages where sr_no=%s and stage_key=%s",
                               (sr, stage_key)).fetchone()
            merged = dict((old["extras"] if old else {}) or {})
            merged.update(extras)
            ex = db_json(merged)
        else:
            old = conn.execute("select extras from ims_request_stages where sr_no=%s and stage_key=%s",
                               (sr, stage_key)).fetchone()
            ex = db_json(dict((old["extras"] if old else {}) or {}))
        conn.execute(
            "insert into ims_request_stages (sr_no, stage_key, approver, planned_at, actual_at, delay_days, status, approved_by, extras) "
            "values (%s,%s,%s,%s,%s,%s,%s,%s,%s) "
            "on conflict (sr_no, stage_key) do update set approver = excluded.approver, planned_at = excluded.planned_at, "
            "actual_at = excluded.actual_at, delay_days = excluded.delay_days, status = excluded.status, "
            "approved_by = excluded.approved_by, extras = excluded.extras",
            (sr, stage_key, row["approver"], row["planned_at"], row["actual_at"], row["delay_days"],
             row["status"], row["approved_by"], ex))


# ---------------------------------------------------------------------------
# Create a PO
# ---------------------------------------------------------------------------
def _create_po(conn, created_by, sr_nos, shared, ctx, created_at=None, mirror=True):
    """Creates one PO from the given items (all must be PO-Preparation approved). Returns po_id."""
    if not sr_nos:
        raise UserError("No items for the PO.")
    items = conn.execute("select * from ims_requests where sr_no = any(%s) for update", (list(sr_nos),)).fetchall()
    if len(items) != len(set(sr_nos)):
        raise UserError("Some selected requests were not found.")
    projects = {i["project"] for i in items}
    if len(projects) > 1:
        raise UserError("A PO can have only one project. Selected projects: " + ", ".join(sorted(projects)) + ".")
    mtypes = {i["material_type"] for i in items}
    if len(mtypes) > 1:
        raise UserError("All materials of one PO must have the same Material Type (Rate Approval depends on it). Found: "
                        + ", ".join(sorted(mtypes)) + ".")
    already = conn.execute("select sr_no from ims_po_items where sr_no = any(%s)", (list(sr_nos),)).fetchall()
    if already:
        raise UserError("Sr No %s already belongs to a PO." % already[0]["sr_no"])
    project, material_type = items[0]["project"], items[0]["material_type"]

    po_no = str(shared.get("poNo") or "").strip().upper()
    if not po_no:
        raise UserError("PO No is required.")
    vendor = str(shared.get("vendorName") or "").strip()
    amount = logic._clean_extra("poAmount", shared.get("poAmount"))
    terms = str(shared.get("paymentTerms") or "").strip()
    adv = shared.get("advancePaymentRequired")
    if adv not in ("Yes", "No"):
        raise UserError("Advance Payment Required must be Yes or No.")

    ts = created_at or now()
    po = conn.execute(
        "insert into ims_purchase_orders (po_no, project, material_type, vendor_name, po_amount, payment_terms, advance_required, created_by, created_at) "
        "values (%s,%s,%s,%s,%s,%s,%s,%s,%s) returning po_id",
        (po_no, project, material_type, vendor, str(amount), terms, adv, created_by, ts)).fetchone()
    po_id = po["po_id"]
    for sr in sr_nos:
        conn.execute("insert into ims_po_items (po_id, sr_no) values (%s,%s)", (po_id, sr))

    # Base of the planned dates = the earliest PO Preparation planned date of the items.
    planned_rows = conn.execute(
        "select min(planned_at) as p from ims_request_stages where sr_no = any(%s) and stage_key = 'poEntry'",
        (list(sr_nos),)).fetchone()
    planned = _planned_map(planned_rows["p"] if planned_rows else None, ts, adv)

    pending_rate = status_values("rateApproval")["pending"]
    for key in _po_stage_keys(adv):
        approver = _approver_for(key, project, material_type, amount, ctx["stage_cfg"])
        status = status_values(key)["pending"]
        conn.execute(
            "insert into ims_po_stages (po_id, stage_key, approver, planned_at, status) values (%s,%s,%s,%s,%s)",
            (po_id, key, approver or "", planned[key], status))
        row = {"approver": approver or "", "planned_at": planned[key], "actual_at": None, "delay_days": None,
               "status": status, "approved_by": ""}
        if mirror:  # in-flight conversion keeps the items' real stage values
            _mirror_to_items(conn, list(sr_nos), key, row)
    log.info("PO %s (id %s) created from items %s", po_no, po_id, sorted(sr_nos))
    return po_id


def create_po_for_items(user_email, sr_nos, shared):
    """Called right after PO Preparation approved the items. One PO per call."""
    with db.connection() as conn:
        ctx = _load_context(conn)
        return _create_po(conn, user_email, sr_nos, shared, ctx)


def validate_po_batch(sr_nos, shared):
    """Checked BEFORE the items are approved so nothing is half done."""
    with db.connection() as conn:
        items = conn.execute("select sr_no, project, material_type from ims_requests where sr_no = any(%s)",
                             (list(sr_nos),)).fetchall()
        if len({i["project"] for i in items}) > 1:
            raise UserError("A PO can have only one project. Select materials of one project only.")
        if len({i["material_type"] for i in items}) > 1:
            raise UserError("All materials of one PO must have the same Material Type. Select one Material Type at a time.")
        if not str(shared.get("poNo") or "").strip():
            raise UserError("PO No is required.")


# ---------------------------------------------------------------------------
# Act on a PO stage
# ---------------------------------------------------------------------------
def _act_po_stage(user, payload):
    if not payload or not payload.get("poId") or not payload.get("stageKey"):
        raise UserError("Missing poId or stageKey.")
    stage_key = payload["stageKey"]
    if stage_key not in POST_PO_KEYS:
        raise UserError("Unknown PO stage: " + str(stage_key))
    stage_def = STAGE_BY_KEY[stage_key]
    extra_fields = payload.get("extraFields") or {}

    with db.connection() as conn:
        po = conn.execute("select * from ims_purchase_orders where po_id = %s for update", (payload["poId"],)).fetchone()
        if not po:
            raise UserError("PO not found.")
        if po["cancelled"]:
            raise UserError("This PO has been cancelled.")
        ctx = _load_context(conn)
        stages = {s["stage_key"]: s for s in conn.execute(
            "select * from ims_po_stages where po_id = %s for update", (po["po_id"],)).fetchall()}
        sr_nos = [r["sr_no"] for r in conn.execute("select sr_no from ims_po_items where po_id = %s", (po["po_id"],)).fetchall()]
        project, material_type = po["project"], po["material_type"]
        adv = po["advance_required"]
        this = stages.get(stage_key)
        if not this:
            raise UserError("This stage is not applicable for this PO.")

        approver_name = _approver_for(stage_key, project, material_type, po["po_amount"], ctx["stage_cfg"])
        _, _, current, is_admin = _identity(user, payload.get("asEmail"))
        is_backup = current in get_access_emails(cfg.ACCESS_TYPES["backup"], project, stage_key, ctx["access"], ctx["people"], material_type)
        if not approver_name and not is_admin and not is_backup:
            raise UserError('No approver configured for "' + stage_def["name"] + '" for this PO yet.')
        approver_email = resolve_email(approver_name, ctx["people"]) if approver_name else ""
        if not is_admin and not is_backup:
            if not approver_email:
                raise UserError('No email on file for "' + approver_name + '" in the People sheet. Please add it there first.')
            if current != approver_email:
                raise UserError('You are not the assigned approver for "' + stage_def["name"] + '" (assigned: ' + approver_name + ").")

        prev_key = get_prev_stage_key(stage_key, adv)
        if prev_key == "poEntry":
            prev_key = None  # a PO exists only after PO Preparation
        if prev_key:
            prev = stages.get(prev_key)
            if not prev or prev["status"] != status_values(prev_key)["done"]:
                raise UserError("Previous stage is not yet " + status_values(prev_key)["done"] + ". Complete it first.")
        sv = status_values(stage_key)
        if this["status"] == sv["done"]:
            raise UserError("This stage is already marked " + sv["done"] + ".")
        for ex in stage_def.get("extra", []):
            val = extra_fields.get(ex["key"])
            if val is None or str(val).strip() == "":
                raise UserError(ex["label"] + " is required.")

        ts = now()
        extras = dict(this["extras"] or {})
        for ex in stage_def.get("extra", []):
            extras[ex["key"]] = logic._clean_extra(ex["key"], extra_fields[ex["key"]])
        delay = delay_days_between(ts, this["planned_at"]) if this["planned_at"] else None
        conn.execute(
            "update ims_po_stages set approver=%s, actual_at=%s, delay_days=%s, status=%s, approved_by=%s, extras=%s "
            "where po_id=%s and stage_key=%s",
            (approver_name or "", ts, delay, sv["done"], current, db_json(extras), po["po_id"], stage_key))
        row = {"approver": approver_name or "", "planned_at": this["planned_at"], "actual_at": ts, "delay_days": delay,
               "status": sv["done"], "approved_by": current}
        _mirror_to_items(conn, sr_nos, stage_key, row, extras if stage_def.get("extra") else None)

        if not get_next_stage_key(stage_key, adv):
            conn.execute("update ims_purchase_orders set status = 'Done' where po_id = %s", (po["po_id"],))
            conn.execute("update ims_requests set status = 'Done' where sr_no = any(%s)", (sr_nos,))


def act_on_po_stage(user, payload):
    try:
        _act_po_stage(user, payload)
        return {"success": True}
    except UserError as err:
        return {"success": False, "error": str(err)}
    except Exception:
        log.exception("imsPoFlowActOnStage failed")
        return {"success": False, "error": "Server error while saving. Please try again."}


# ---------------------------------------------------------------------------
# Cancel a PO (always the whole PO)
# ---------------------------------------------------------------------------
def cancel_po(user, payload):
    try:
        payload = payload or {}
        reason = str(payload.get("reason") or "").strip()
        if not payload.get("poId"):
            raise UserError("Missing poId.")
        if not reason:
            raise UserError("Cancel Reason is required.")
        with db.connection() as conn:
            po = conn.execute("select * from ims_purchase_orders where po_id = %s for update", (payload["poId"],)).fetchone()
            if not po:
                raise UserError("PO not found.")
            if po["cancelled"]:
                raise UserError("This PO has already been cancelled.")
            ctx = _load_context(conn)
            _, _, current, is_admin = _identity(user, payload.get("asEmail"))
            grantees = (get_access_emails(cfg.ACCESS_TYPES["cancel"], po["project"], "ALL", ctx["access"], ctx["people"])
                        + logic.stage_config_emails(po["project"], ctx["stage_cfg"], ctx["people"]))
            if not is_admin and current not in grantees:
                raise UserError('Only an admin, a Stage Config approver of this project, or a user with Cancel Permission '
                                'for "' + po["project"] + '" can cancel this PO.')
            sr_nos = [r["sr_no"] for r in conn.execute("select sr_no from ims_po_items where po_id = %s order by sr_no",
                                                       (po["po_id"],)).fetchall()]
        errors = []
        for sr in sr_nos:
            res = logic.cancel_request_impl(user, {"srNo": sr, "reason": reason, "cancelDate": payload.get("cancelDate"),
                                                   "asEmail": payload.get("asEmail")}, skip_item_guard=True)
            if not res.get("success") and "already been cancelled" not in str(res.get("error", "")):
                errors.append("Sr No %s: %s" % (sr, res.get("error")))
        if errors:
            return {"success": False, "error": "; ".join(errors)}
        with db.connection() as conn:
            row = conn.execute("select cancelled_at from ims_requests where sr_no = %s", (sr_nos[0],)).fetchone() if sr_nos else None
            conn.execute(
                "update ims_purchase_orders set cancelled = true, cancelled_by = %s, cancelled_at = %s, cancel_reason = %s where po_id = %s",
                (current, (row["cancelled_at"] if row and row["cancelled_at"] else now()), reason, po["po_id"]))
            conn.execute("update ims_po_stages set planned_at = null where po_id = %s", (po["po_id"],))
        return {"success": True, "cancelledItems": len(sr_nos)}
    except UserError as err:
        return {"success": False, "error": str(err)}
    except Exception:
        log.exception("imsPoFlowCancel failed")
        return {"success": False, "error": "Server error while cancelling. Please try again."}


# ---------------------------------------------------------------------------
# Read
# ---------------------------------------------------------------------------
def list_pos(user, as_email=None):
    """All POs with items and stages, for the PO Flow page."""
    if not enabled():
        return {"enabled": False, "pos": []}
    _, _, current, is_admin = _identity(user, as_email)
    with db.connection() as conn:
        ctx = _load_context(conn)
        pos = conn.execute("select * from ims_purchase_orders order by po_id desc").fetchall()
        stage_rows = conn.execute("select * from ims_po_stages").fetchall()
        item_rows = conn.execute(
            "select i.po_id, r.sr_no, r.material_name, r.quantity, r.uom, s.extras->>'indentNo' as indent_no "
            "from ims_po_items i join ims_requests r on r.sr_no = i.sr_no "
            "left join ims_request_stages s on s.sr_no = r.sr_no and s.stage_key = 'indent' order by r.sr_no").fetchall()
    stages_by_po, items_by_po = {}, {}
    for s in stage_rows:
        stages_by_po.setdefault(s["po_id"], {})[s["stage_key"]] = s
    for it in item_rows:
        items_by_po.setdefault(it["po_id"], []).append(it)

    cancel_cache = {}

    def can_cancel(project):
        if project not in cancel_cache:
            cancel_cache[project] = (is_admin or current in (
                get_access_emails(cfg.ACCESS_TYPES["cancel"], project, "ALL", ctx["access"], ctx["people"])
                + logic.stage_config_emails(project, ctx["stage_cfg"], ctx["people"])))
        return cancel_cache[project]

    out = []
    for po in pos:
        st = stages_by_po.get(po["po_id"], {})
        adv = po["advance_required"]
        stage_list = []
        for key in _po_stage_keys(adv):
            s = st.get(key)
            if not s:
                continue
            sv = status_values(key)
            approver_name = s["approver"] or ""
            approver_email = resolve_email(approver_name, ctx["people"]) if approver_name else ""
            is_backup = current in get_access_emails(cfg.ACCESS_TYPES["backup"], po["project"], key, ctx["access"],
                                                     ctx["people"], po["material_type"])
            mine = bool(is_admin or (approver_email and approver_email == current) or is_backup)
            prev_key = get_prev_stage_key(key, adv)
            if prev_key == "poEntry":
                prev_key = None
            prev_done = True
            if prev_key:
                p = st.get(prev_key)
                prev_done = bool(p) and p["status"] == status_values(prev_key)["done"]
            done = s["status"] == sv["done"]
            entry = {"key": key, "name": STAGE_BY_KEY[key]["name"], "approver": approver_name,
                     "planned": fmt_dt(s["planned_at"]), "actual": fmt_dt(s["actual_at"]),
                     "delay": _num(s["delay_days"]) if s["delay_days"] is not None else "",
                     "status": s["status"], "done": done, "approvedBy": s["approved_by"] or "",
                     "isMine": mine, "canAct": bool(not po["cancelled"] and not done and prev_done and mine),
                     "extra": [{"key": e["key"], "label": e["label"], "value": (s["extras"] or {}).get(e["key"], "")}
                               for e in STAGE_BY_KEY[key].get("extra", [])]}
            stage_list.append(entry)
        items = items_by_po.get(po["po_id"], [])
        indents = sorted({i["indent_no"] for i in items if i["indent_no"]})
        out.append({
            "poId": po["po_id"], "poNo": po["po_no"], "project": po["project"], "materialType": po["material_type"],
            "vendorName": po["vendor_name"], "poAmount": po["po_amount"], "paymentTerms": po["payment_terms"],
            "advanceRequired": adv, "status": po["status"], "createdBy": po["created_by"],
            "createdAt": fmt_dt(po["created_at"]), "cancelled": bool(po["cancelled"]),
            "cancelledBy": po["cancelled_by"], "cancelledAt": fmt_dt(po["cancelled_at"]), "cancelReason": po["cancel_reason"],
            "canCancel": bool(not po["cancelled"] and can_cancel(po["project"])),
            "indentNos": indents,
            "items": [{"srNo": i["sr_no"], "materialName": i["material_name"], "quantity": _num(i["quantity"]),
                       "uom": i["uom"] or "", "indentNo": i["indent_no"] or ""} for i in items],
            "stages": stage_list,
        })
    return {"enabled": True, "pos": out}


def status(user):
    return {"enabled": enabled(), "isAdmin": (user or "").strip().lower() in cfg.ADMIN_EMAILS}


def set_enabled(user, on):
    if (user or "").strip().lower() not in cfg.ADMIN_EMAILS:
        return {"success": False, "error": "Only an admin can change this."}
    try:
        with db.connection() as conn:
            conn.execute(
                "insert into ims_settings (key, value) values ('po_flow_enabled', %s) "
                "on conflict (key) do update set value = excluded.value", ("on" if on else "off",))
        return {"success": True, "enabled": bool(on)}
    except Exception:
        log.exception("set_enabled failed")
        return {"success": False, "error": "Could not save. Did you run migration_po_flow.sql?"}


# ---------------------------------------------------------------------------
# Convert requests that are already past PO Preparation ("new way")
# ---------------------------------------------------------------------------
def convert_in_flight(user):
    """Groups items by (project, PO No in CAPS, PO Preparation time to the minute) into POs. Idempotent.
    Each PO stage is Done only if every item of the group is Done for that stage. Old rows are not touched
    except that their stage values are re-mirrored from the PO (identical for fully-done stages)."""
    if (user or "").strip().lower() not in cfg.ADMIN_EMAILS:
        return {"success": False, "error": "Only an admin can run this."}
    created, skipped = 0, 0
    with db.connection() as conn:
        ctx = _load_context(conn)
        rows = conn.execute(
            "select r.sr_no, r.project, r.material_type, s.actual_at, s.extras, s.approved_by "
            "from ims_requests r join ims_request_stages s on s.sr_no = r.sr_no and s.stage_key = 'poEntry' "
            "where not r.cancelled and r.entry_status = 'Done' and s.status = %s "
            "and not exists (select 1 from ims_po_items i where i.sr_no = r.sr_no) "
            "and not exists (select 1 from ims_request_stages t where t.sr_no = r.sr_no and t.stage_key = 'truckEntry' and t.status = %s) "
            "order by r.sr_no", (status_values("poEntry")["done"], status_values("truckEntry")["done"])).fetchall()
        groups = {}
        for r in rows:
            po_no = str((r["extras"] or {}).get("poNo", "")).strip().upper()
            if not po_no:
                skipped += 1
                continue
            minute = r["actual_at"].replace(second=0, microsecond=0) if r["actual_at"] else None
            groups.setdefault((r["project"], po_no, minute), []).append(r)
        for (project, po_no, minute), items in groups.items():
            by_type = {}
            for it in items:
                by_type.setdefault(it["material_type"], []).append(it)
            for mtype, members in by_type.items():
                ex = members[0]["extras"] or {}
                shared = {"poNo": po_no, "vendorName": ex.get("vendorName", ""), "poAmount": ex.get("poAmount", ""),
                          "paymentTerms": ex.get("paymentTerms", ""),
                          "advancePaymentRequired": ex.get("advancePaymentRequired") or "No"}
                sr_nos = [m["sr_no"] for m in members]
                try:
                    with conn.transaction():
                        po_id = _create_po(conn, members[0]["approved_by"] or user, sr_nos, shared, ctx, created_at=minute, mirror=False)
                        _sync_po_from_items(conn, po_id, sr_nos)
                    created += 1
                except Exception:
                    log.exception("Could not convert PO %s of %s", po_no, project)
                    skipped += len(sr_nos)
    return {"success": True, "created": created, "skippedWithoutPoNo": skipped}


def _sync_po_from_items(conn, po_id, sr_nos):
    """For a converted PO: a stage is Done only when every item is Done; the PO takes the latest item values."""
    po = conn.execute("select advance_required from ims_purchase_orders where po_id=%s", (po_id,)).fetchone()
    for key in _po_stage_keys(po["advance_required"]):
        rows = conn.execute("select * from ims_request_stages where sr_no = any(%s) and stage_key = %s",
                            (list(sr_nos), key)).fetchall()
        done_label = status_values(key)["done"]
        if rows and len(rows) == len(sr_nos) and all(r["status"] == done_label for r in rows):
            last = max(rows, key=lambda r: r["actual_at"] or dt.datetime.min.replace(tzinfo=dt.timezone.utc))
            extras = {}
            for e in STAGE_BY_KEY[key].get("extra", []):
                extras[e["key"]] = (last["extras"] or {}).get(e["key"], "")
            planned = conn.execute("select planned_at from ims_po_stages where po_id=%s and stage_key=%s", (po_id, key)).fetchone()["planned_at"]
            delay = delay_days_between(last["actual_at"], planned) if (last["actual_at"] and planned) else None
            conn.execute(
                "update ims_po_stages set actual_at=%s, delay_days=%s, status=%s, approved_by=%s, extras=%s where po_id=%s and stage_key=%s",
                (last["actual_at"], delay, done_label, last["approved_by"], db_json(extras), po_id, key))
            row = {"approver": last["approver"], "planned_at": planned, "actual_at": last["actual_at"], "delay_days": delay,
                   "status": done_label, "approved_by": last["approved_by"]}
            _mirror_to_items(conn, list(sr_nos), key, row, extras or None)
    last_key = _po_stage_keys(po["advance_required"])[-1]
    fin = conn.execute("select status from ims_po_stages where po_id=%s and stage_key=%s", (po_id, last_key)).fetchone()
    if fin and fin["status"] == status_values(last_key)["done"]:
        conn.execute("update ims_purchase_orders set status='Done' where po_id=%s", (po_id,))


# ---------------------------------------------------------------------------
# Rows for the "PO Tracker" sheet tab (one PO = one row)
# ---------------------------------------------------------------------------
def tracker_rows(user):
    data = list_pos(user)
    rows = []
    for po in data.get("pos", []):
        st = {s["key"]: s for s in po["stages"]}
        row = {
            "PO ID": po["poId"], "PO No": po["poNo"], "Project": po["project"], "Supplier Name": po["vendorName"],
            "Indent Nos": ", ".join(po["indentNos"]),
            "Materials": "; ".join("%s (%s %s)" % (i["materialName"], i["quantity"], i["uom"]) for i in po["items"]),
            "PO Amount": po["poAmount"], "Advance Required": po["advanceRequired"], "Status": "Cancelled" if po["cancelled"] else po["status"],
            "Cancel Reason": po["cancelReason"], "Cancelled At": po["cancelledAt"], "Created At": po["createdAt"],
        }
        for key in POST_PO_KEYS:
            s = st.get(key)
            nm = STAGE_BY_KEY[key]["name"]
            row[nm + " Planned"] = s["planned"] if s else ""
            row[nm + " Actual"] = s["actual"] if s else ""
            row[nm + " Status"] = s["status"] if s else ""
            row[nm + " Delay"] = s["delay"] if s else ""
        rows.append(row)
    return rows


# ---------------------------------------------------------------------------
# Queue entries for the Approval Flow stage cards (one entry per PO per pending stage)
# ---------------------------------------------------------------------------
def queue_entries(user, as_email=None):
    """Same shape idea as the item queue: one entry per (PO, pending stage) the user may see.
    Rate Approval, Advance Payment, Delivery, GRN and Truck Entry cards show POs instead of items."""
    data = list_pos(user, as_email)
    if not data.get("enabled"):
        return []
    _, _, current, is_admin = _identity(user, as_email)
    with db.connection() as conn:
        planned = {(r["po_id"], r["stage_key"]): r["planned_at"] for r in
                   conn.execute("select po_id, stage_key, planned_at from ims_po_stages").fetchall()}
    out = []
    for po in data["pos"]:
        if po["cancelled"]:
            continue
        materials = "; ".join("%s (%s %s)" % (i["materialName"], i["quantity"], i["uom"]) for i in po["items"])
        for idx, s in enumerate(po["stages"]):
            if s["done"] or not s["isMine"]:
                continue
            if is_admin and not s["approver"]:
                continue
            blocker = next((p for p in po["stages"][:idx] if not p["done"]), None)
            out.append({
                "isPo": True, "poId": po["poId"], "srNo": "PO%s" % po["poId"], "poNo": po["poNo"],
                "project": po["project"], "materialName": "PO " + po["poNo"],
                "materialType": po["materialType"], "vendorName": po["vendorName"], "poAmount": po["poAmount"],
                "paymentTerms": po["paymentTerms"], "advanceRequired": po["advanceRequired"],
                "indentNos": po["indentNos"], "items": po["items"], "stages": po["stages"],
                "canCancel": po["canCancel"],
                "tileQty": "%d item%s" % (len(po["items"]), "" if len(po["items"]) == 1 else "s"),
                "searchText": " ".join([po["poNo"], po["vendorName"], po["project"], materials, " ".join(po["indentNos"])]).lower(),
                "stageKey": s["key"], "stageName": s["name"], "planned": s["planned"], "status": s["status"],
                "approver": s["approver"], "canAct": s["canAct"],
                "blockedByStageKey": blocker["key"] if blocker else "",
                "blockedByStageName": blocker["name"] if blocker else "",
                "blockedByApprover": blocker["approver"] if blocker else "",
                "_plannedDt": planned.get((po["poId"], s["key"])),
            })
    return out
