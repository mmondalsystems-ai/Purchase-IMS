"""
One-time (or repeatable) import of the master tabs from the downloaded Google Sheet
(File > Download > Microsoft Excel) into Supabase.

    python import_masters.py Purchase_IMS_Backend.xlsx
    python import_masters.py Purchase_IMS_Backend.xlsx --reset-remaining
    python import_masters.py Purchase_IMS_Backend.xlsx --only people,stage_config

Tabs imported:
    People, Vendor Master, Material Master, Stage Config, Access Control,
    Material Quantity Master
The "Approval Tracker" tab is NOT imported (it is empty / transactional data).

Safe to run again: people and stage config are updated, vendors and materials only get
new names, Access Control is replaced, and Material Quantity Master keeps the current
Remaining of existing rows (the app deducts from it) unless --reset-remaining is given.

It calls the same SQL function (ims_sync_masters) as the Apps Script sync, so both
paths behave identically.
"""
import argparse
import os
import sys
from pathlib import Path

import openpyxl
import psycopg
from dotenv import load_dotenv
from psycopg.types.json import Jsonb

BASE_DIR = Path(__file__).resolve().parent
QTY_CHUNK = 2000
ALL_PARTS = ["people", "vendors", "materials", "stage_config", "access_control", "qty_master"]


def text(value) -> str:
    return "" if value is None else str(value).strip()


def number(value):
    """Cell value -> number or None (the sheet has a few numbers stored as text, like '40.0')."""
    if value is None or (isinstance(value, str) and not value.strip()):
        return None
    if isinstance(value, (int, float)):
        return value
    try:
        return float(str(value).replace(",", "").strip())
    except ValueError:
        return None


def rows_of(wb, name):
    if name not in wb.sheetnames:
        raise SystemExit('Sheet tab "%s" was not found in the workbook.' % name)
    return [list(r) for r in wb[name].iter_rows(values_only=True)]


def build_people(wb):
    out = []
    for r in rows_of(wb, "People")[1:]:
        if text(r[0]):
            out.append({"name": text(r[0]), "email": text(r[1] if len(r) > 1 else "")})
    return out


def build_single_column(wb, name):
    return [text(r[0]) for r in rows_of(wb, name)[1:] if text(r[0])]


def build_stage_config(wb):
    rows = rows_of(wb, "Stage Config")
    header = rows[0]
    out = []
    for r in rows[1:]:
        key = text(r[1] if len(r) > 1 else "")
        if not key:
            continue
        for c in range(3, len(header)):
            project = text(header[c])
            approver = text(r[c] if c < len(r) else "")
            if not project or approver.startswith("(computed"):
                continue
            out.append({"stage_key": key, "project": project, "approver": approver})
    return out


def build_access_control(wb):
    out = []
    for r in rows_of(wb, "Access Control")[1:]:
        cells = [text(r[i]) if i < len(r) else "" for i in range(5)]
        if not any(cells):
            continue
        out.append({"access_types": cells[0], "projects": cells[1], "stage_keys": cells[2],
                    "notes": cells[3], "names_emails": cells[4]})
    return out


def build_qty_master(wb):
    out, seen = [], {}
    for r in rows_of(wb, "Material Quantity Master")[1:]:
        r = (r + [None] * 8)[:8]
        material, project = text(r[4]), text(r[7])
        if not material and not project:
            continue  # fully blank row
        combo = (project, text(r[1]), text(r[2]), text(r[3]), material)
        seen[combo] = seen.get(combo, 0) + 1
        out.append({
            "material_status": text(r[0]), "construction_type": combo[1], "block": combo[2], "lot": combo[3],
            "material_name": material, "total_qty": number(r[5]), "remaining": number(r[6]),
            "project": project, "dup_no": seen[combo],
        })
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("xlsx", help="Downloaded Excel copy of the Purchase IMS Backend sheet")
    ap.add_argument("--reset-remaining", action="store_true",
                    help="Overwrite Remaining in Material Quantity Master with the sheet values")
    ap.add_argument("--only", default="", help="Comma separated subset of: " + ", ".join(ALL_PARTS))
    args = ap.parse_args()

    load_dotenv(BASE_DIR / ".env")
    url = os.environ.get("DATABASE_URL", "").strip()
    if not url:
        sys.exit("DATABASE_URL is not set. Copy .env.example to .env and fill it in.")

    parts = [p.strip() for p in args.only.split(",") if p.strip()] or ALL_PARTS
    bad = [p for p in parts if p not in ALL_PARTS]
    if bad:
        sys.exit("Unknown part(s): " + ", ".join(bad))

    wb = openpyxl.load_workbook(args.xlsx, read_only=True, data_only=True)
    builders = {
        "people": lambda: build_people(wb),
        "vendors": lambda: build_single_column(wb, "Vendor Master"),
        "materials": lambda: build_single_column(wb, "Material Master"),
        "stage_config": lambda: build_stage_config(wb),
        "access_control": lambda: build_access_control(wb),
    }

    with psycopg.connect(url, prepare_threshold=None, autocommit=True) as conn:
        small = {}
        for part in parts:
            if part in builders:
                small[part] = builders[part]()
                print("%-15s %6d rows read" % (part, len(small[part])))
        if small:
            res = conn.execute("select ims_sync_masters(%s::jsonb, false)", (Jsonb(small),)).fetchone()[0]
            print("  database result:", res)

        if "qty_master" in parts:
            qty = build_qty_master(wb)
            print("%-15s %6d rows read" % ("qty_master", len(qty)))
            for i in range(0, len(qty), QTY_CHUNK):
                chunk = qty[i:i + QTY_CHUNK]
                conn.execute("select ims_sync_masters(%s::jsonb, %s)",
                             (Jsonb({"qty_master": chunk}), bool(args.reset_remaining)))
                print("  qty_master rows %d-%d sent" % (i + 1, i + len(chunk)))

    print("Done.")


if __name__ == "__main__":
    main()
