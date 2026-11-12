"""Fills a THROWAWAY test database with small synthetic masters so tests/smoke_test.py can run.
    export DATABASE_URL=postgresql://...  ;  python tests/seed_test_db.py
Never run it against production."""
import os, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import config as cfg
import db

PEOPLE = {
    "Bikash Haldar": "bikash@oswalgroup.net", "Tulika Saha": "tulika@oswalgroup.net", "Somnath Mondal": "somnath@oswalgroup.net",
    "Rishabh Prajapati": "rishabh@oswalgroup.net", "Atanu Jana": "atanu@oswalgroup.net", "Sourav Mondal": "sourav@oswalgroup.net",
    "Pradip Acharya": "pradip@oswalgroup.net", "Ashish Halder": "ashish@oswalgroup.net", "Bappaditya Ghosh": "bappa@oswalgroup.net",
    "Subhodip Neogi": "subho@oswalgroup.net", "Pritam Hazra": "pritam@oswalgroup.net", "Moumita Sasmal": "moumita@oswalgroup.net",
    "Sandip Das": "sandip@oswalgroup.net", "Suman Pradhan": "suman@oswalgroup.net", "Asish Adhikary": "asish@oswalgroup.net",
    "Amar Sharma": "amar@oswalgroup.net", "Managing Director": "md@oswalgroup.net", "Chinmoy Sit": "chinmoy@oswalgroup.net",
}
SEED = {
    "approval": {"HO": "Tulika Saha", "*": "Bikash Haldar"},
    "approval2": {"HO": "Rishabh Prajapati", "*": "Somnath Mondal"},
    "wbs": {"Orchard Avaasa": "Sourav Mondal", "*": "Atanu Jana"},
    "indent": {"Orchard Amritaya": "Pradip Acharya", "Orchard Anantaa": "Ashish Halder", "Newtown Rajarhat": "Bappaditya Ghosh",
               "Orchard Avaasa": "Subhodip Neogi", "Titagarh": "Pritam Hazra", "HO": "Pradip Acharya"},
    "poRate": {"*": "Rishabh Prajapati"},
    "poEntry": {"Orchard Amritaya": "Moumita Sasmal", "Orchard Avaasa": "Moumita Sasmal", "Titagarh": "Moumita Sasmal", "*": "Tulika Saha"},
    "advancePayment": {"*": "Sandip Das"},
    "delivery": {"Newtown Rajarhat": "Suman Pradhan", "*": "Ashish Halder"},
    "grn": {"Newtown Rajarhat": "Suman Pradhan", "*": "Asish Adhikary"},
    "truckEntry": {"Newtown Rajarhat": "Suman Pradhan", "*": "Asish Adhikary"},
}
with db.connection() as conn:
    for n, e in PEOPLE.items():
        conn.execute("insert into ims_people (name, email) values (%s,%s) on conflict (lower(name)) do update set email = excluded.email", (n, e))
    for stage, by in SEED.items():
        for proj in cfg.PROJECTS:
            conn.execute("insert into ims_stage_config (stage_key, project, approver) values (%s,%s,%s) "
                         "on conflict (stage_key, project) do update set approver = excluded.approver", (stage, proj, by.get(proj, by.get("*", ""))))
    conn.execute("delete from ims_access_control where true")
    conn.execute("insert into ims_access_control (sort_order, access_types, projects, stage_keys, notes, names_emails) values "
                 "(1,'New Entry Permission',%s,'','','Chinmoy Sit'),(2,'Cancel Permission',%s,'','',''),(3,'Backup Approver',%s,'ALL','','')",
                 (", ".join(cfg.PROJECTS),) * 3)
    for v in ("ABC TRADERS", "XYZ SUPPLIES"):
        conn.execute("insert into ims_vendors (name) values (%s) on conflict do nothing", (v,))
    for m in ("CEMENT", "SAND", "BRICK", "TMT", "PAINT"):
        conn.execute("insert into ims_materials (name) values (%s) on conflict do nothing", (m,))
    n = 0
    for i in range(1, 30):
        conn.execute("insert into ims_qty_master (construction_type, block, lot, material_name, uom, total_qty, remaining, project, dup_no) "
                     "values ('Civil', %s, %s, %s, %s, 100, 100, 'Orchard Amritaya', 1) on conflict do nothing",
                     ("B%d" % (i % 3), "L%d" % (i % 5), "MAT-%d" % i, "NOS"))
print("seeded")
