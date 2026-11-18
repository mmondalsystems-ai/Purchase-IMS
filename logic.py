"""
Python port of Approval_Code.gs (IMS Purchase Approval Tracker).

Every function that the web page calls keeps the SAME NAME as in Apps Script
(imsApprovalGetRequests, imsApprovalActOnStage, ...). The first argument of those
functions is always the signed-in user's email, which replaces
Session.getActiveUser().getEmail(); the remaining arguments are exactly what
google.script.run used to pass.

Differences from the Apps Script version (all deliberate fixes):
  * Data lives in Supabase tables instead of sheet rows (see schema.sql).
  * Every write is one database transaction, and the request row is locked while a
    stage is changed, so two people cannot overwrite each other.
  * A Planned entry is rejected if its Quantity is more than the Remaining in
    Material Quantity Master (the old code let Remaining go negative).
  * Cancelling gives quantity back only for Planned entries (only those deducted).
  * Starting a draft's approval flow is limited to its requester or an admin.
  * Advance Payment Stage cannot be approved when Advance Payment Required is not Yes.
"""
import datetime as dt
import logging
import re
from decimal import Decimal, InvalidOperation

import config as cfg
import db

log = logging.getLogger("ims")


class UserError(Exception):
    """An error whose message is safe to show to the user."""


# ---------------------------------------------------------------------------
# Time helpers (script timezone = APP_TZ, like Session.getScriptTimeZone())
# ---------------------------------------------------------------------------

_now_override = None  # tests can set a callable returning an aware datetime


def now() -> dt.datetime:
    if _now_override is not None:
        return _now_override()
    return dt.datetime.now(cfg.APP_TZ)


def _as_tz(value: dt.datetime) -> dt.datetime:
    if value.tzinfo is None:
        value = value.replace(tzinfo=cfg.APP_TZ)
    return value.astimezone(cfg.APP_TZ)


def fmt_date(value) -> str:
    """dd-MMM-yyyy"""
    if not value:
        return ""
    if isinstance(value, dt.datetime):
        value = _as_tz(value).date()
    return value.strftime("%d-%b-%Y")


def fmt_dt(value) -> str:
    """dd-MMM-yyyy hh:mm a"""
    if not value:
        return ""
    return _as_tz(value).strftime("%d-%b-%Y %I:%M %p")


def add_days(value: dt.datetime, days: int) -> dt.datetime:
    return _as_tz(value) + dt.timedelta(days=days)


def days_between(a: dt.datetime, b: dt.datetime) -> int:
    """Whole days from a to b, by calendar date (same as imsApprovalDaysBetween_)."""
    return (_as_tz(b).date() - _as_tz(a).date()).days


def delay_days_between(actual: dt.datetime, planned: dt.datetime) -> float:
    """Planned minus actual, in days with 2 decimals (time of day counts).
    Approved AFTER the planned time -> negative (1 hour late = -0.04); on time or early -> 0 or positive."""
    secs = (_as_tz(planned) - _as_tz(actual)).total_seconds()
    return round(secs / 86400.0, 2)


def _num(value):
    """Decimal/None -> int / float / '' so JSON looks like the sheet values did."""
    if value is None:
        return ""
    if isinstance(value, Decimal):
        if value == value.to_integral_value():
            return int(value)
        return float(value)
    return value


# ---------------------------------------------------------------------------
# Stage helpers
# ---------------------------------------------------------------------------

STAGE_BY_KEY = {s["key"]: s for s in cfg.STAGE_DEFS}


def status_values(stage_key: str) -> dict:
    stage = STAGE_BY_KEY.get(stage_key)
    if stage and stage.get("statusValues"):
        return stage["statusValues"]
    return {"pending": "Not Approved", "done": "Approved"}


def get_next_stage_key(current_key, advance_required):
    idx = next((i for i, s in enumerate(cfg.STAGE_DEFS) if s["key"] == current_key), -1)
    if idx == -1 or idx == len(cfg.STAGE_DEFS) - 1:
        return None
    if current_key == "rateApproval":
        return "advancePayment" if advance_required == "Yes" else "delivery"
    return cfg.STAGE_DEFS[idx + 1]["key"]


def get_prev_stage_key(current_key, advance_required):
    if current_key == "advancePayment":
        return "rateApproval"
    if current_key == "delivery":
        return "advancePayment" if advance_required == "Yes" else "rateApproval"
    idx = next((i for i, s in enumerate(cfg.STAGE_DEFS) if s["key"] == current_key), -1)
    if idx <= 0:
        return None
    prev_key = cfg.STAGE_DEFS[idx - 1]["key"]
    if prev_key == "advancePayment":
        return "rateApproval"
    return prev_key


# ---------------------------------------------------------------------------
# People / Stage Config / Access Control
# ---------------------------------------------------------------------------

_EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")


def looks_like_email(value) -> bool:
    return bool(_EMAIL_RE.match(str(value or "").strip()))


def parse_name_list(value) -> list:
    return [n.strip() for n in str(value if value is not None else "").split(",") if n.strip()]


def read_people_map(conn) -> dict:
    rows = conn.execute("select name, email from ims_people").fetchall()
    return {str(r["name"]).strip().lower(): str(r["email"] or "").strip().lower() for r in rows}


def resolve_email(name, people_map) -> str:
    if not name:
        return ""
    raw = str(name).strip()
    if looks_like_email(raw):
        return raw.lower()
    return people_map.get(raw.lower(), "") or ""


def resolve_emails(value, people_map) -> list:
    out = []
    for n in parse_name_list(value):
        if looks_like_email(n):
            out.append(n.lower())
        else:
            e = people_map.get(n.lower(), "")
            if e:
                out.append(e)
    return out


def read_stage_config(conn) -> dict:
    """{stage_key: {'byProject': {project: approver}}}"""
    rows = conn.execute("select stage_key, project, approver from ims_stage_config").fetchall()
    out = {}
    for r in rows:
        out.setdefault(r["stage_key"], {"byProject": {}})["byProject"][r["project"]] = (r["approver"] or "").strip()
    return out


def normalize_access_type(value) -> str:
    v = str(value or "").strip()
    lower = v.lower()
    if not lower:
        return ""
    t = cfg.ACCESS_TYPES
    if lower in (t["newEntry"].lower(), "new entry", "request", "requestpermission",
                 "request permission", "raise new request", "raise purchase request",
                 "new purchase request"):
        return t["newEntry"]
    if lower in (t["cancel"].lower(), "cancel", "cancelpermission", "cancel request"):
        return t["cancel"]
    if lower in (t["backup"].lower(), "backup", "backup approvers", "backup approval"):
        return t["backup"]
    return v


def parse_access_type_list(value) -> list:
    return [t for t in (normalize_access_type(x) for x in parse_name_list(value)) if t]


def normalize_access_project(value) -> str:
    v = str(value or "").strip()
    lower = v.lower()
    if not lower:
        return ""
    if lower in ("all", "all projects", "*", "any"):
        return "ALL"
    for p in cfg.PROJECTS:
        if p.lower() == lower:
            return p
    return v


def parse_access_project_list(value) -> list:
    return [p for p in (normalize_access_project(x) for x in parse_name_list(value)) if p]


def normalize_access_stage_key(value) -> str:
    v = str(value or "").strip()
    lower = v.lower()
    if not lower or lower in ("all", "all stages", "*", "any"):
        return "ALL"
    for s in cfg.STAGE_DEFS:
        if s["key"].lower() == lower or s["name"].lower() == lower:
            return s["key"]
    return v


def parse_access_stage_key_list(value) -> list:
    raw = "ALL" if value is None or value == "" else value
    return [k for k in (normalize_access_stage_key(x) for x in parse_name_list(raw)) if k]


def access_row_key(access_type, project, stage_key) -> str:
    return "|".join([
        normalize_access_type(access_type).lower(),
        normalize_access_project(project).lower(),
        normalize_access_stage_key(stage_key).lower(),
    ])


def read_access_config(conn) -> dict:
    rows = conn.execute(
        "select access_types, projects, stage_keys, names_emails "
        "from ims_access_control order by sort_order, id"
    ).fetchall()
    out = {}
    for r in rows:
        access_types = parse_access_type_list(r["access_types"])
        projects = parse_access_project_list(r["projects"])
        stage_keys = parse_access_stage_key_list(r["stage_keys"])
        users = str(r["names_emails"] or "").strip()
        if not (access_types and projects and stage_keys and users):
            continue
        for access_type in access_types:
            effective = stage_keys if access_type == cfg.ACCESS_TYPES["backup"] else ["ALL"]
            for project in projects:
                for stage_key in effective:
                    out.setdefault(access_row_key(access_type, project, stage_key), []).append(users)
    return out


def get_access_emails(access_type, project, stage_key, access_cfg, people_map) -> list:
    type_ = normalize_access_type(access_type)
    stage = normalize_access_stage_key(stage_key)
    projects = []
    if project:
        projects.append(normalize_access_project(project))
    projects.append("ALL")
    stages = [stage]
    if stage.lower() != "all":
        stages.append("ALL")
    raw = []
    for p in projects:
        for s in stages:
            raw += access_cfg.get(access_row_key(type_, p, s), [])
    seen, out = set(), []
    for e in resolve_emails(",".join(raw), people_map):
        if e not in seen:
            seen.add(e)
            out.append(e)
    return out


def get_approver_name(stage_key, project, material_type, po_amount, stage_cfg) -> str:
    stage = STAGE_BY_KEY.get(stage_key)
    if not stage:
        return ""
    if stage.get("computedApprover"):
        if po_amount is None or po_amount == "":
            return ""
        try:
            amt = float(po_amount)
        except (TypeError, ValueError):
            return ""
        if amt != amt:  # NaN
            return ""
        mt = str(material_type or "").strip().upper()
        for rule in cfg.RATE_APPROVAL_RULES:
            if rule["materialType"] == mt and amt <= rule["maxAmount"]:
                return rule["approver"]
        return ""
    entry = stage_cfg.get(stage_key)
    if not entry:
        return ""
    return entry["byProject"].get(project, "") or ""


def stage_config_emails(project, stage_cfg, people_map) -> list:
    """Everyone named as approver for ANY stage of this project in Stage Config."""
    emails = set()
    for entry in (stage_cfg or {}).values():
        approver = entry["byProject"].get(project, "")
        if approver:
            emails.update(resolve_emails(approver, people_map))
    return sorted(emails)


def _load_context(conn) -> dict:
    return {
        "people": read_people_map(conn),
        "stage_cfg": read_stage_config(conn),
        "access": read_access_config(conn),
    }


# ---------------------------------------------------------------------------
# Identity (replaces Session.getActiveUser + the admin-only "Test As" feature)
# ---------------------------------------------------------------------------

def _identity(real_email, as_email=None):
    real_user = (real_email or "").strip().lower()
    real_is_admin = real_user in cfg.ADMIN_EMAILS
    current = str(as_email).strip().lower() if (as_email and real_is_admin) else real_user
    return real_user, real_is_admin, current, current in cfg.ADMIN_EMAILS


# ---------------------------------------------------------------------------
# Static lookups called by the page
# ---------------------------------------------------------------------------

def imsApprovalGetStageConfigForClient():
    return [
        {
            "key": s["key"],
            "name": s["name"],
            "conditional": bool(s.get("conditional")),
            "computedApprover": bool(s.get("computedApprover")),
            "extra": s.get("extra", []),
            "statusValues": status_values(s["key"]),
        }
        for s in cfg.STAGE_DEFS
    ]


def imsApprovalGetProjectsForClient():
    return list(cfg.PROJECTS)


def imsApprovalGetMaterialTypesForClient():
    return list(cfg.MATERIAL_TYPES)


def imsApprovalGetCurrentUserEmail(user):
    return user or ""


def imsApprovalGetCurrentUserInfo(user, asEmail=None):
    real_email = user or ""
    real_is_admin = real_email.lower() in cfg.ADMIN_EMAILS
    testing = bool(asEmail and real_is_admin)
    effective = str(asEmail).strip() if testing else real_email
    return {
        "email": effective,
        "isAdmin": effective.lower() in cfg.ADMIN_EMAILS,
        "realEmail": real_email,
        "realIsAdmin": real_is_admin,
        "testing": testing,
    }


def imsApprovalGetVendors():
    with db.connection() as conn:
        rows = conn.execute("select name from ims_vendors").fetchall()
    return sorted(r["name"] for r in rows if r["name"])


def imsApprovalGetMaterials():
    with db.connection() as conn:
        rows = conn.execute("select name from ims_materials").fetchall()
    return sorted(r["name"] for r in rows if r["name"])


def imsApprovalGetTasks():
    with db.connection() as conn:
        rows = conn.execute("select name from ims_tasks").fetchall()
    return sorted(r["name"] for r in rows if r["name"])


def imsApprovalGetQtyMasterForProject(project):
    if not project:
        return []
    with db.connection() as conn:
        rows = conn.execute(
            "select construction_type, block, lot, material_name, uom, total_qty, remaining "
            "from ims_qty_master where project = %s order by id",
            (project,),
        ).fetchall()
    return [
        {
            "constructionType": r["construction_type"],
            "block": r["block"], "lot": r["lot"], "materialName": r["material_name"], "uom": r["uom"] or "",
            "totalQty": _num(r["total_qty"]), "remaining": _num(r["remaining"]),
        }
        for r in rows
    ]


def imsApprovalGetRequestableProjects(user, asEmail=None):
    _, _, current, is_admin = _identity(user, asEmail)
    if is_admin:
        return list(cfg.PROJECTS)
    with db.connection() as conn:
        ctx = _load_context(conn)
    return [
        p for p in cfg.PROJECTS
        if current in get_access_emails(cfg.ACCESS_TYPES["newEntry"], p, "ALL", ctx["access"], ctx["people"])
    ]


# ---------------------------------------------------------------------------
# Quantity Master (deduct on Planned submit, give back on cancel)
# ---------------------------------------------------------------------------

def _find_qty_row(conn, project, construction_type, block, lot, material_name):
    """First matching Material Quantity Master row (locked), or None."""
    return conn.execute(
        "select id, remaining from ims_qty_master "
        "where project = %s and construction_type = %s and block = %s and lot = %s and material_name = %s "
        "order by dup_no, id limit 1 for update",
        (project, construction_type, block, lot, material_name),
    ).fetchone()


# ---------------------------------------------------------------------------
# Stage initialisation (planned dates), approver lookup
# ---------------------------------------------------------------------------

def _blank_stage_row():
    return {"approver": "", "planned_at": None, "actual_at": None, "delay_days": None,
            "status": "", "approved_by": "", "extras": {}}


def _initialize_stages(conn, sr_no, project, material_type, base_ts, stage_cfg):
    """Port of imsApprovalInitializeStages_: statuses, approvers and every planned date."""
    rows = {}
    for stage in cfg.STAGE_DEFS:
        r = _blank_stage_row()
        r["status"] = status_values(stage["key"])["pending"]
        if not stage.get("computedApprover"):
            r["approver"] = get_approver_name(stage["key"], project, material_type, "", stage_cfg)
        rows[stage["key"]] = r

    approval_planned = add_days(base_ts, 1)
    rows["approval"]["planned_at"] = approval_planned
    prev_planned = approval_planned
    po_prep_planned = None  # PO Preparation Stage (poEntry): Delivery planned = this + 15 days
    for stage in cfg.STAGE_DEFS[1:]:
        key = stage["key"]
        if key == "advancePayment":
            continue  # set later, only if actually required
        if key == "delivery":
            planned = add_days(po_prep_planned, 15)
        else:
            planned = add_days(prev_planned, 1)
        rows[key]["planned_at"] = planned
        if key == "poEntry":
            po_prep_planned = planned
        prev_planned = planned

    for key, r in rows.items():
        conn.execute(
            "insert into ims_request_stages (sr_no, stage_key, approver, planned_at, status, extras) "
            "values (%s, %s, %s, %s, %s, '{}'::jsonb) "
            "on conflict (sr_no, stage_key) do update set "
            "approver = excluded.approver, planned_at = excluded.planned_at, status = excluded.status",
            (sr_no, key, r["approver"], r["planned_at"], r["status"]),
        )


# ---------------------------------------------------------------------------
# New Entry
# ---------------------------------------------------------------------------

def _parse_decimal(raw):
    try:
        d = Decimal(str(raw).strip())
    except (InvalidOperation, ValueError):
        return None
    return d if d.is_finite() else None


def _parse_iso_date(value):
    if not value:
        return None
    try:
        return dt.date.fromisoformat(str(value)[:10])
    except ValueError:
        return None


def imsApprovalSubmitRequest(user, payload):
    try:
        payload = payload or {}
        is_planned = payload.get("planned") == "Planned"
        if not payload.get("project") or not payload.get("materialName") or not payload.get("materialType"):
            raise UserError("Project, Material Name, and Material Type are required.")
        if is_planned and (not payload.get("constructionType") or not payload.get("block") or not payload.get("lot")):
            raise UserError("Construction Type, Block, and LOT are required for a Planned entry.")
        quantity = _parse_decimal(payload.get("quantity")) if payload.get("quantity") not in (None, "", 0) else None
        if quantity is None or quantity <= 0:
            raise UserError("Quantity must be a number greater than 0.")
        uom = str(payload.get("uom") or "").strip()
        if not uom:
            raise UserError("UOM is required.")
        if not str(payload.get("taskName") or "").strip():
            raise UserError("Task Name is required.")
        if not str(payload.get("pointOfUses") or "").strip():
            raise UserError("Point of Uses is required.")
        if not payload.get("estimatedDeliveryDate"):
            raise UserError("Estimated Delivery Date is required.")
        entry_status = "Done"  # always Done: every new request starts its approval flow

        user_email = user or "unknown"
        user_lower = user_email.lower()
        project = payload["project"]

        with db.connection() as conn:
            task_name = str(payload.get("taskName") or "").strip()
            if task_name:
                found = conn.execute("select name from ims_tasks where lower(name) = lower(%s)", (task_name,)).fetchone()
                if not found:
                    raise UserError("Task Name must be chosen from the Task Master list.")
                task_name = found["name"]
            ctx = _load_context(conn)
            if user_lower not in cfg.ADMIN_EMAILS:
                allowed = get_access_emails(cfg.ACCESS_TYPES["newEntry"], project, "ALL", ctx["access"], ctx["people"])
                if user_lower not in allowed:
                    raise UserError(
                        'You do not have permission to raise a purchase request for "' + project +
                        '". Ask an admin to add you to Access Control → New Entry Permission for that project.'
                    )

            # Check the quantity BEFORE inserting, so a rejected request never uses up a Sr No.
            qty_match, new_remaining = None, None
            if is_planned:
                qty_match = _find_qty_row(conn, project, payload["constructionType"], payload["block"],
                                          payload["lot"], payload["materialName"])
                if qty_match:
                    remaining = qty_match["remaining"] or Decimal(0)
                    if remaining < quantity:
                        raise UserError(
                            "Quantity %s is more than the Remaining %s in Material Quantity Master for this material."
                            % (_num(quantity), _num(remaining))
                        )
                    new_remaining = remaining - quantity

            ts = now()
            row = conn.execute(
                "insert into ims_requests (project, planned, construction_type, block, lot, material_name, "
                "material_type, task_name, point_of_uses, uom, quantity, estimated_delivery_date, status, entry_status, user_email, remarks, entry_timestamp) "
                "values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'Not Done',%s,%s,%s,%s) returning sr_no",
                (project, "Planned" if is_planned else "Non Planned",
                 payload.get("constructionType") or "", payload.get("block") or "", payload.get("lot") or "",
                 payload["materialName"], payload["materialType"],
                 task_name, str(payload.get("pointOfUses") or "").strip(), uom, quantity,
                 _parse_iso_date(payload.get("estimatedDeliveryDate")), entry_status,
                 user_email, payload.get("remarks") or "", ts),
            ).fetchone()
            sr_no = row["sr_no"]

            if entry_status == "Done":
                _initialize_stages(conn, sr_no, project, payload["materialType"], ts, ctx["stage_cfg"])
            # Not Done = draft: no stage rows exist, nothing is actionable until Start Approval Flow.

            qty_synced, remaining_after = False, None
            if qty_match:
                conn.execute("update ims_qty_master set remaining = %s where id = %s", (new_remaining, qty_match["id"]))
                qty_synced, remaining_after = True, _num(new_remaining)

        return {"success": True, "srNo": sr_no, "qtySynced": qty_synced, "remainingAfter": remaining_after}
    except UserError as err:
        return {"success": False, "error": str(err)}
    except Exception:
        log.exception("imsApprovalSubmitRequest failed")
        return {"success": False, "error": "Server error while saving the request. Please try again."}


def imsApprovalStartFlow(user, srNo):
    try:
        with db.connection() as conn:
            req = conn.execute("select * from ims_requests where sr_no = %s for update", (srNo,)).fetchone()
            if not req:
                raise UserError("Request Sr No %s not found." % srNo)
            if req["cancelled"]:
                raise UserError("This request has been cancelled.")
            if req["entry_status"] == "Done":
                raise UserError("This request’s approval flow has already started.")
            u = (user or "").lower()
            if u not in cfg.ADMIN_EMAILS and u != (req["user_email"] or "").lower():
                raise UserError("Only the requester or an admin can start this approval flow.")
            stage_cfg = read_stage_config(conn)
            _initialize_stages(conn, srNo, req["project"], req["material_type"], now(), stage_cfg)
            conn.execute("update ims_requests set entry_status = 'Done' where sr_no = %s", (srNo,))
        return {"success": True}
    except UserError as err:
        return {"success": False, "error": str(err)}
    except Exception:
        log.exception("imsApprovalStartFlow failed")
        return {"success": False, "error": "Server error. Please try again."}


# ---------------------------------------------------------------------------
# Read: all requests (fully parsed), my queue, my stage keys
# ---------------------------------------------------------------------------

def _requests_impl(conn, current_user, is_admin, ctx):
    req_rows = conn.execute("select * from ims_requests order by sr_no desc").fetchall()
    stage_rows = conn.execute("select * from ims_request_stages").fetchall()
    stages_by_req = {}
    for s in stage_rows:
        stages_by_req.setdefault(s["sr_no"], {})[s["stage_key"]] = s

    backup_cache = {}

    def backup_emails(project, stage_key):
        k = (project, stage_key)
        if k not in backup_cache:
            backup_cache[k] = get_access_emails(cfg.ACCESS_TYPES["backup"], project, stage_key, ctx["access"], ctx["people"])
        return backup_cache[k]

    cancel_cache = {}

    def cancel_emails(project):
        if project not in cancel_cache:
            cancel_cache[project] = sorted(set(
                get_access_emails(cfg.ACCESS_TYPES["cancel"], project, "ALL", ctx["access"], ctx["people"])
                + stage_config_emails(project, ctx["stage_cfg"], ctx["people"])))
        return cancel_cache[project]

    out = []
    for r in req_rows:
        project = r["project"]
        material_type = r["material_type"]
        entry_status = r["entry_status"] or "Not Done"
        stage_data = stages_by_req.get(r["sr_no"], {})

        req = {
            "rowIndex": r["sr_no"],
            "srNo": r["sr_no"],
            "project": project,
            "planned": r["planned"] or "Non Planned",
            "constructionType": r["construction_type"],
            "block": r["block"],
            "lot": r["lot"],
            "materialName": r["material_name"],
            "materialType": material_type,
            "taskName": r["task_name"] or "",
            "pointOfUses": r["point_of_uses"] or "",
            "uom": r["uom"] or "",
            "quantity": _num(r["quantity"]),
            "estimatedDeliveryDate": fmt_date(r["estimated_delivery_date"]),
            "overallStatus": r["status"] or "Not Done",
            "entryStatus": entry_status,
            "cancelled": bool(r["cancelled"]),
            "cancelledBy": r["cancelled_by"] or "",
            "cancelledAt": fmt_dt(r["cancelled_at"]),
            "cancelReason": r["cancel_reason"] or "",
            "userEmail": r["user_email"],
            "remarks": r["remarks"],
            "entryTimestamp": fmt_dt(r["entry_timestamp"]),
            "stages": {},
        }
        req["canCancel"] = (not req["cancelled"]) and (
            is_admin or current_user in cancel_emails(project))

        po_entry = stage_data.get("poEntry")
        po_amount = (po_entry["extras"].get("poAmount", "") if po_entry else "")
        adv_for_gating = (po_entry["extras"].get("advancePaymentRequired", "") if po_entry else "") or ""

        for stage in cfg.STAGE_DEFS:
            key = stage["key"]
            srow = stage_data.get(key)
            approver_name = (srow["approver"] if srow else "") or ""
            if not approver_name and entry_status == "Done":
                approver_name = get_approver_name(key, project, material_type, po_amount, ctx["stage_cfg"])
            approver_email = resolve_email(approver_name, ctx["people"])
            sv = status_values(key)
            status = (srow["status"] if srow else "") or sv["pending"]
            is_backup = current_user in backup_emails(project, key)

            prev_key = get_prev_stage_key(key, adv_for_gating)
            prev_done = True
            if prev_key:
                prev = req["stages"].get(prev_key)
                prev_done = bool(prev) and prev["status"] == status_values(prev_key)["done"]

            mine = bool(is_admin or (approver_email and approver_email == current_user) or is_backup)
            sd = {
                "approver": approver_name,
                "planned": fmt_dt(srow["planned_at"]) if srow else "",
                "actual": fmt_dt(srow["actual_at"]) if srow else "",
                "delay": (_num(srow["delay_days"]) if srow and srow["delay_days"] is not None else ""),
                "status": status,
                "approvedBy": (srow["approved_by"] if srow else "") or "",
                "canCurrentUserAct": bool(entry_status == "Done" and status != sv["done"] and prev_done and mine),
                "isMyStage": mine,
                "_plannedDt": srow["planned_at"] if srow else None,
            }
            for ex in stage.get("extra", []):
                sd[ex["key"]] = (srow["extras"].get(ex["key"]) if srow else "") or ""
            req["stages"][key] = sd
        out.append(req)
    return out


def _strip_internal(reqs):
    for r in reqs:
        for sd in r["stages"].values():
            sd.pop("_plannedDt", None)
    return reqs


def imsApprovalGetRequests(user, asEmail=None):
    _, _, current, is_admin = _identity(user, asEmail)
    with db.connection() as conn:
        ctx = _load_context(conn)
        reqs = _requests_impl(conn, current, is_admin, ctx)
    return _strip_internal(reqs)


def _blocking_predecessor(req, stage_key):
    """Earliest not-Done stage in the chain behind stage_key (same chain the real gating uses)."""
    sd = req["stages"].get(stage_key)
    if not sd or sd["status"] == status_values(stage_key)["done"]:
        return None
    adv = (req["stages"].get("poEntry") or {}).get("advancePaymentRequired")
    earliest, key = None, stage_key
    for _ in range(len(cfg.STAGE_DEFS)):
        prev_key = get_prev_stage_key(key, adv)
        if not prev_key:
            break
        prev = req["stages"].get(prev_key)
        if not prev or prev["status"] != status_values(prev_key)["done"]:
            earliest = prev_key
        key = prev_key
    if not earliest:
        return None
    prev = req["stages"].get(earliest)
    return {"key": earliest, "name": STAGE_BY_KEY[earliest]["name"], "approver": prev["approver"] if prev else ""}


def imsApprovalGetMyQueue(user, asEmail=None):
    _, _, current, is_admin = _identity(user, asEmail)
    with db.connection() as conn:
        ctx = _load_context(conn)
        reqs = _requests_impl(conn, current, is_admin, ctx)

    queue = []
    for req in reqs:
        if req["cancelled"]:
            continue
        for stage in cfg.STAGE_DEFS:
            sd = req["stages"].get(stage["key"])
            if not sd:
                continue
            if stage["key"] == "advancePayment":
                if (req["stages"].get("poEntry") or {}).get("advancePaymentRequired") != "Yes":
                    continue
            done_label = status_values(stage["key"])["done"]
            pending_and_unlocked = sd["status"] != done_label and bool(sd["approver"])
            # Admins: every pending, unlocked stage. Everyone else: every stage assigned to them that is
            # not done yet, even while still locked behind an earlier stage (canAct stays gated separately).
            include = pending_and_unlocked if is_admin else (sd["isMyStage"] and sd["status"] != done_label)
            if not include:
                continue
            blocker = _blocking_predecessor(req, stage["key"])
            st = req["stages"]
            queue.append({
                "srNo": req["srNo"], "project": req["project"], "planType": req["planned"],
                "materialName": req["materialName"], "materialType": req["materialType"],
                "constructionType": req["constructionType"], "block": req["block"], "lot": req["lot"],
                "taskName": req["taskName"], "pointOfUses": req["pointOfUses"],
                "uom": req["uom"], "quantity": req["quantity"], "remarks": req["remarks"], "requestedBy": req["userEmail"],
                "entryTimestamp": req["entryTimestamp"], "estimatedDeliveryDate": req["estimatedDeliveryDate"],
                "indentNo": st["indent"]["indentNo"] if "indent" in st else "",
                "vendorName": st["poEntry"]["vendorName"] if "poEntry" in st else "",
                "poAmount": st["poEntry"]["poAmount"] if "poEntry" in st else "",
                "poNo": st["poEntry"]["poNo"] if "poEntry" in st else "",
                "paymentTerms": st["poEntry"]["paymentTerms"] if "poEntry" in st else "",
                "challanBillNo": st["delivery"]["challanBillNo"] if "delivery" in st else "",
                "stageKey": stage["key"], "stageName": stage["name"],
                "blockedByStageKey": blocker["key"] if blocker else "",
                "blockedByStageName": blocker["name"] if blocker else "",
                "blockedByApprover": blocker["approver"] if blocker else "",
                "planned": sd["planned"], "status": sd["status"], "approver": sd["approver"],
                "canAct": sd["canCurrentUserAct"],
                "_plannedDt": sd["_plannedDt"],
            })

    far = dt.datetime.max.replace(tzinfo=dt.timezone.utc)
    queue.sort(key=lambda q: (q["_plannedDt"] is None, _as_tz(q["_plannedDt"]) if q["_plannedDt"] else far))
    for q in queue:
        q.pop("_plannedDt", None)
    return queue


def imsApprovalGetMyStageKeys(user, asEmail=None):
    _, _, current, is_admin = _identity(user, asEmail)
    if is_admin:
        return [s["key"] for s in cfg.STAGE_DEFS]
    with db.connection() as conn:
        ctx = _load_context(conn)
    keys = []
    for stage in cfg.STAGE_DEFS:
        assigned = False
        if stage.get("computedApprover"):
            for rule in cfg.RATE_APPROVAL_RULES:
                if resolve_email(rule["approver"], ctx["people"]) == current:
                    assigned = True
        else:
            entry = ctx["stage_cfg"].get(stage["key"])
            if entry:
                for approver in entry["byProject"].values():
                    if current in resolve_emails(approver, ctx["people"]):
                        assigned = True
        if not assigned:
            for proj in cfg.PROJECTS:
                if current in get_access_emails(cfg.ACCESS_TYPES["backup"], proj, stage["key"], ctx["access"], ctx["people"]):
                    assigned = True
        if assigned:
            keys.append(stage["key"])
    return keys


# ---------------------------------------------------------------------------
# Act on a stage
# ---------------------------------------------------------------------------

def _clean_extra(key, value):
    """Extra field values: poAmount is stored as a number when it is numeric."""
    if value is None:
        return ""
    if key == "poAmount":
        d = _parse_decimal(value)
        if d is not None and str(value).strip() != "":
            return int(d) if d == d.to_integral_value() else float(d)
        return str(value).strip()
    return value.strip() if isinstance(value, str) else value


def _act_on_stage(user, payload):
    if not payload or not payload.get("srNo") or not payload.get("stageKey"):
        raise UserError("Missing srNo or stageKey.")
    stage_key = payload["stageKey"]
    stage_def = STAGE_BY_KEY.get(stage_key)
    if not stage_def:
        raise UserError("Unknown stage: " + str(stage_key))
    extra_fields = payload.get("extraFields") or {}

    with db.connection() as conn:
        req = conn.execute("select * from ims_requests where sr_no = %s for update", (payload["srNo"],)).fetchone()
        if not req:
            raise UserError("Request Sr No %s not found." % payload["srNo"])
        if req["cancelled"]:
            raise UserError("This request has been cancelled.")
        if (req["entry_status"] or "Not Done") != "Done":
            raise UserError("This request is still a draft — start its approval flow first.")

        ctx = _load_context(conn)
        stages = {s["stage_key"]: s for s in conn.execute(
            "select * from ims_request_stages where sr_no = %s for update", (req["sr_no"],)).fetchall()}
        project, material_type = req["project"], req["material_type"]

        po_entry = stages.get("poEntry")
        po_existing = po_entry["extras"].get("poAmount", "") if po_entry else ""
        po_for_approver = extra_fields["poAmount"] if (stage_key == "poEntry" and extra_fields.get("poAmount")) else po_existing
        approver_name = get_approver_name(stage_key, project, material_type, po_for_approver, ctx["stage_cfg"])

        _, _, current, is_admin = _identity(user, payload.get("asEmail"))
        is_backup = current in get_access_emails(cfg.ACCESS_TYPES["backup"], project, stage_key, ctx["access"], ctx["people"])
        if not approver_name and not is_admin and not is_backup:
            raise UserError('No approver configured for "' + stage_def["name"] + '" for this request yet.')
        approver_email = resolve_email(approver_name, ctx["people"]) if approver_name else ""
        if not is_admin and not is_backup:
            if not approver_email:
                raise UserError('No email on file for "' + approver_name + '" in the People sheet. Please add it there first.')
            if current != approver_email:
                raise UserError('You are not the assigned approver for "' + stage_def["name"] + '" (assigned: ' + approver_name + ").")

        adv_req = (po_entry["extras"].get("advancePaymentRequired", "") if po_entry else "") or ""
        if stage_key == "advancePayment" and adv_req != "Yes":
            raise UserError("Advance Payment Stage is not applicable for this request.")

        prev_key = get_prev_stage_key(stage_key, adv_req)
        if prev_key:
            prev = stages.get(prev_key)
            prev_done_label = status_values(prev_key)["done"]
            if not prev or prev["status"] != prev_done_label:
                raise UserError("Previous stage is not yet " + prev_done_label + ". Complete it first.")

        sv = status_values(stage_key)
        this = stages.get(stage_key) or _blank_stage_row()
        if this["status"] == sv["done"]:
            raise UserError("This stage is already marked " + sv["done"] + ".")

        if stage_key == "poEntry":
            adv_val = extra_fields.get("advancePaymentRequired")
            if adv_val not in ("Yes", "No"):
                raise UserError("Advance Payment Required must be explicitly set to Yes or No.")

        # Every extra field is required on every stage EXCEPT PO Rate Stage (its Remarks stays optional).
        if stage_key != "poRate":
            for ex in stage_def.get("extra", []):
                val = extra_fields.get(ex["key"])
                if val is None or str(val).strip() == "":
                    raise UserError(ex["label"] + " is required.")

        ts = now()
        planned_val = this["planned_at"]
        extras = dict(this["extras"] or {})
        for ex in stage_def.get("extra", []):
            if ex["key"] in extra_fields:
                extras[ex["key"]] = _clean_extra(ex["key"], extra_fields[ex["key"]])

        delay = delay_days_between(ts, planned_val) if planned_val else None
        conn.execute(
            "insert into ims_request_stages (sr_no, stage_key, approver, planned_at, actual_at, delay_days, status, approved_by, extras) "
            "values (%s,%s,%s,%s,%s,%s,%s,%s,%s) "
            "on conflict (sr_no, stage_key) do update set approver = excluded.approver, actual_at = excluded.actual_at, "
            "delay_days = excluded.delay_days, status = excluded.status, approved_by = excluded.approved_by, extras = excluded.extras",
            (req["sr_no"], stage_key, approver_name, planned_val, ts, delay, sv["done"], current,
             db_json(extras)),
        )

        if stage_key == "poEntry":
            po_now = extra_fields["poAmount"] if "poAmount" in extra_fields and extra_fields["poAmount"] is not None else po_existing
            po_now = _clean_extra("poAmount", po_now) if po_now != "" else ""
            rate_name = get_approver_name("rateApproval", project, material_type, po_now, ctx["stage_cfg"])
            if rate_name:
                conn.execute(
                    "insert into ims_request_stages (sr_no, stage_key, approver, status) values (%s,'rateApproval',%s,%s) "
                    "on conflict (sr_no, stage_key) do update set approver = excluded.approver",
                    (req["sr_no"], rate_name, status_values("rateApproval")["pending"]),
                )

        adv_now = adv_req
        if stage_key == "poEntry" and extra_fields.get("advancePaymentRequired"):
            adv_now = extra_fields["advancePaymentRequired"]
        # Advance Payment sits right after Rate Approval; whether it is needed was fixed at PO Preparation.
        # Once Rate Approval itself is completed, set Advance Payment's planned date (its planned + 1).
        if stage_key == "rateApproval":
            if adv_now == "Yes":
                adv_planned = add_days(planned_val, 1) if planned_val else add_days(ts, 1)
                conn.execute(
                    "insert into ims_request_stages (sr_no, stage_key, planned_at, status) values (%s,'advancePayment',%s,%s) "
                    "on conflict (sr_no, stage_key) do update set planned_at = excluded.planned_at",
                    (req["sr_no"], adv_planned, status_values("advancePayment")["pending"]),
                )

        if not get_next_stage_key(stage_key, adv_now):
            conn.execute("update ims_requests set status = 'Done' where sr_no = %s", (req["sr_no"],))


def db_json(value):
    from psycopg.types.json import Jsonb
    return Jsonb(value)


def imsApprovalActOnStage(user, payload):
    try:
        _act_on_stage(user, payload)
        return {"success": True}
    except UserError as err:
        return {"success": False, "error": str(err)}
    except Exception:
        log.exception("imsApprovalActOnStage failed")
        return {"success": False, "error": "Server error while saving. Please try again."}


def _act_on_many(user, payload, shared_fields):
    items = (payload or {}).get("items") or []
    if not items:
        return {"success": False, "successCount": 0, "failureCount": 0, "results": [], "error": "No requests selected."}
    if len(items) > 50:
        return {"success": False, "successCount": 0, "failureCount": len(items), "results": [],
                "error": "Select 50 or fewer requests at a time."}
    seen, results = set(), []
    for item in items:
        sr_no = (item or {}).get("srNo")
        stage_key = (item or {}).get("stageKey")
        result = {"srNo": sr_no, "stageKey": stage_key, "success": False}
        if not sr_no or not stage_key:
            result["error"] = "Missing request number or stage."
            results.append(result)
            continue
        key = "%s|%s" % (stage_key, sr_no)
        if key in seen:
            continue
        seen.add(key)
        res = imsApprovalActOnStage(user, {"srNo": sr_no, "stageKey": stage_key, "extraFields": dict(shared_fields),
                                           "asEmail": payload.get("asEmail") or ""})
        result["success"] = bool(res and res.get("success"))
        if not result["success"]:
            result["error"] = (res or {}).get("error") or "Failed."
        results.append(result)
    ok = sum(1 for r in results if r["success"])
    return {"success": ok == len(results), "successCount": ok, "failureCount": len(results) - ok, "results": results}


def imsApprovalActOnStages(user, payload):
    return _act_on_many(user, payload, {})


def imsApprovalActOnStagesWithSharedFields(user, payload):
    """Same batch, but ONE shared extraFields object (vendor / PO amount / PO no / advance) for every item."""
    return _act_on_many(user, payload, (payload or {}).get("extraFields") or {})


# ---------------------------------------------------------------------------
# Cancel
# ---------------------------------------------------------------------------

def imsApprovalCancelMany(user, payload):
    """Cancels several requests with one shared reason/date. Each request is cancelled on its own,
    so one failure (for example no permission) never blocks the others; the result lists every outcome."""
    payload = payload or {}
    sr_nos = payload.get("srNos") or []
    if not sr_nos:
        return {"success": False, "error": "No requests selected."}
    results, done = [], 0
    for sr in sr_nos:
        one = imsApprovalCancelRequest(user, {"srNo": sr, "reason": payload.get("reason"),
                                              "cancelDate": payload.get("cancelDate"), "asEmail": payload.get("asEmail")})
        if one.get("success"):
            done += 1
        results.append({"srNo": sr, "success": bool(one.get("success")), "error": one.get("error", ""),
                        "remainingAfter": one.get("remainingAfter")})
    return {"success": done > 0, "doneCount": done, "total": len(sr_nos), "results": results,
            "error": "" if done else (results[0]["error"] if results else "Failed.")}


def imsApprovalCancelRequest(user, payload):
    try:
        if not payload or not payload.get("srNo"):
            raise UserError("Missing srNo.")
        reason = str(payload.get("reason") or "").strip()
        if not reason:
            raise UserError("Cancel Reason is required.")

        with db.connection() as conn:
            req = conn.execute("select * from ims_requests where sr_no = %s for update", (payload["srNo"],)).fetchone()
            if not req:
                raise UserError("Request Sr No %s not found." % payload["srNo"])
            if req["cancelled"]:
                raise UserError("This request has already been cancelled.")

            ctx = _load_context(conn)
            project = req["project"]
            _, _, current, is_admin = _identity(user, payload.get("asEmail"))
            grantees = (get_access_emails(cfg.ACCESS_TYPES["cancel"], project, "ALL", ctx["access"], ctx["people"])
                        + stage_config_emails(project, ctx["stage_cfg"], ctx["people"]))
            if not is_admin and current not in grantees:
                raise UserError(
                    "Only an admin, a Stage Config approver of this project, or a user with Cancel Permission in "
                    'Access Control for "' + project + '" can cancel this request.'
                )

            cancel_date = now()
            d = _parse_iso_date(payload.get("cancelDate"))
            if d:
                cancel_date = dt.datetime(d.year, d.month, d.day, tzinfo=cfg.APP_TZ)

            conn.execute(
                "update ims_requests set cancelled = true, cancelled_by = %s, cancelled_at = %s, cancel_reason = %s where sr_no = %s",
                (current, cancel_date, reason, req["sr_no"]),
            )

            qty_synced, remaining_after = False, None
            if req["planned"] == "Planned" and req["quantity"] and req["quantity"] > 0:
                match = _find_qty_row(conn, project, req["construction_type"], req["block"], req["lot"], req["material_name"])
                if match:
                    new_remaining = (match["remaining"] or Decimal(0)) + req["quantity"]
                    conn.execute("update ims_qty_master set remaining = %s where id = %s", (new_remaining, match["id"]))
                    qty_synced, remaining_after = True, _num(new_remaining)

        return {"success": True, "qtyRestored": qty_synced, "remainingAfter": remaining_after}
    except UserError as err:
        return {"success": False, "error": str(err)}
    except Exception:
        log.exception("imsApprovalCancelRequest failed")
        return {"success": False, "error": "Server error while cancelling. Please try again."}


# ---------------------------------------------------------------------------
# Registry used by app.py:  name -> (function, needs_user)
# ---------------------------------------------------------------------------

API = {
    "imsApprovalGetStageConfigForClient": (imsApprovalGetStageConfigForClient, False),
    "imsApprovalGetProjectsForClient": (imsApprovalGetProjectsForClient, False),
    "imsApprovalGetMaterialTypesForClient": (imsApprovalGetMaterialTypesForClient, False),
    "imsApprovalGetVendors": (imsApprovalGetVendors, False),
    "imsApprovalGetMaterials": (imsApprovalGetMaterials, False),
    "imsApprovalGetTasks": (imsApprovalGetTasks, False),
    "imsApprovalGetQtyMasterForProject": (imsApprovalGetQtyMasterForProject, False),
    "imsApprovalGetCurrentUserEmail": (imsApprovalGetCurrentUserEmail, True),
    "imsApprovalGetCurrentUserInfo": (imsApprovalGetCurrentUserInfo, True),
    "imsApprovalGetRequestableProjects": (imsApprovalGetRequestableProjects, True),
    "imsApprovalSubmitRequest": (imsApprovalSubmitRequest, True),
    "imsApprovalStartFlow": (imsApprovalStartFlow, True),
    "imsApprovalGetRequests": (imsApprovalGetRequests, True),
    "imsApprovalGetMyQueue": (imsApprovalGetMyQueue, True),
    "imsApprovalGetMyStageKeys": (imsApprovalGetMyStageKeys, True),
    "imsApprovalActOnStage": (imsApprovalActOnStage, True),
    "imsApprovalActOnStages": (imsApprovalActOnStages, True),
    "imsApprovalActOnStagesWithSharedFields": (imsApprovalActOnStagesWithSharedFields, True),
    "imsApprovalCancelRequest": (imsApprovalCancelRequest, True),
    "imsApprovalCancelMany": (imsApprovalCancelMany, True),
}
