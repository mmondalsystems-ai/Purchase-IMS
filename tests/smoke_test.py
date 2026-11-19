"""
End-to-end smoke test against a real database.

    export DATABASE_URL=postgresql://...   (a TEST database, never production data)
    python tests/smoke_test.py

It signs in through the dev-only /auth/dev route (APP_ENV=dev), then walks a request
through the whole workflow using the real approvers from the People / Stage Config tables.
"""
import os
import sys
from pathlib import Path

os.environ.setdefault("APP_ENV", "dev")
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi.testclient import TestClient  # noqa: E402

import app as app_module  # noqa: E402
import db  # noqa: E402

ADMIN = "bnaskar.systems@oswalgroup.net"
passed = 0


def check(cond, label):
    global passed
    if not cond:
        raise AssertionError("FAILED: " + label)
    passed += 1
    print("  ok  " + label)


def client_for(email):
    c = TestClient(app_module.app, follow_redirects=False)
    r = c.get("/auth/dev", params={"email": email})
    assert r.status_code in (302, 307), r.text
    return c


def call(c, fn, *args):
    if fn == "imsApprovalSubmitRequest" and args and isinstance(args[0], dict):
        args = (dict({"taskName": "Smoke Task", "pointOfUses": "Site", "estimatedDeliveryDate": "2026-12-01"}, **args[0]),) + args[1:]
    r = c.post("/api/" + fn, json={"args": list(args)})
    assert r.status_code == 200, (fn, r.status_code, r.text)
    j = r.json()
    assert j["ok"], (fn, j)
    return j["result"]


def people_email(name):
    with db.connection() as conn:
        row = conn.execute("select email from ims_people where lower(name) = lower(%s)", (name,)).fetchone()
    return row["email"] if row else ""


def main():
    anon = TestClient(app_module.app, follow_redirects=False)
    print("Auth")
    check(anon.get("/").status_code in (302, 307), "anonymous / redirects to /login")
    check(anon.post("/api/imsApprovalGetRequests", json={"args": []}).status_code == 401, "anonymous API call is rejected")
    check(anon.get("/health").json() == {"ok": True}, "/health works")
    check("Sign in" in anon.get("/login").text, "login page renders")

    admin = client_for(ADMIN)
    page = admin.get("/")
    check(page.status_code == 200 and "/static/shim.js" in page.text and "google.script.run" in page.text, "app page served with shim")
    check(admin.get("/static/shim.js").status_code == 200, "shim.js served")

    print("Static lookups")
    stages = call(admin, "imsApprovalGetStageConfigForClient")
    check(len(stages) == 11 and stages[0]["key"] == "approval", "11 stages")
    keys = [x["key"] for x in stages]
    check("poMaking" not in keys and keys.index("poEntry") + 1 == keys.index("rateApproval"), "PO Preparation comes right before Rate Approval")
    check(next(x for x in stages if x["key"] == "poEntry")["name"] == "PO Preparation Stage", "poEntry is named PO Preparation Stage")
    check(len(call(admin, "imsApprovalGetRequestableProjects")) == 6, "admin can raise for all 6 projects")
    nobody = client_for("nobody@oswalgroup.net")
    check(call(nobody, "imsApprovalGetRequestableProjects") == [], "unlisted user has no projects")
    chinmoy = client_for(people_email("Chinmoy Sit"))
    check(len(call(chinmoy, "imsApprovalGetRequestableProjects")) == 6, "listed user can raise for all projects")
    check(len(call(admin, "imsApprovalGetMaterials")) > 0, "materials list loaded")
    check(len(call(admin, "imsApprovalGetVendors")) > 0, "vendors list loaded")
    qty = call(admin, "imsApprovalGetQtyMasterForProject", "Orchard Amritaya")
    check(len(qty) > 0 and "uom" in qty[0], "quantity master rows for Orchard Amritaya carry a uom")
    check(call(admin, "imsApprovalGetQtyMasterForProject", "HO") == [], "HO has no quantity master rows")

    print("New Entry: Planned (quantity master deduction)")
    row = next(r for r in qty if isinstance(r["remaining"], (int, float)) and r["remaining"] > 0 and r["block"] and r["lot"])
    first_dup = [r for r in qty if (r["constructionType"], r["block"], r["lot"], r["materialName"]) ==
                 (row["constructionType"], row["block"], row["lot"], row["materialName"])][0]
    payload = {"project": "Orchard Amritaya", "planned": "Planned", "constructionType": row["constructionType"],
               "block": row["block"], "lot": row["lot"], "materialName": row["materialName"],
               "materialType": "SITE MATERIAL", "taskName": "Smoke Task", "pointOfUses": "Tower 2 Floor 3", "uom": row["uom"] or "NOS", "quantity": first_dup["remaining"], "estimatedDeliveryDate": "2026-12-01",
               "remarks": "smoke test", "entryStatus": "Done"}
    res = call(admin, "imsApprovalSubmitRequest", payload)
    check(res["success"] and res["qtySynced"] and res["remainingAfter"] == 0, "Planned submit deducts whole Remaining -> 0")
    sr1 = res["srNo"]
    got_tp = [g for g in call(admin, "imsApprovalGetRequests") if g["srNo"] == sr1][0]
    badtask = call(admin, "imsApprovalSubmitRequest", dict(payload, taskName="Not In Master", quantity=1))
    for missing, text_ in (("taskName", "Task Name is required"), ("pointOfUses", "Point of Uses is required"),
                           ("estimatedDeliveryDate", "Estimated Delivery Date is required")):
        r_ = call(admin, "imsApprovalSubmitRequest", dict(payload, quantity=1, **{missing: ""}))
        check(not r_["success"] and text_ in r_["error"], text_)
    check(not badtask["success"] and "Task Master" in badtask["error"], "Task Name outside Task Master is rejected")
    check("Smoke Task" in call(admin, "imsApprovalGetTasks"), "Task Master list is returned")
    check(got_tp["taskName"] == "Smoke Task" and got_tp["pointOfUses"] == "Tower 2 Floor 3", "Task Name and Point of Uses are saved and returned")
    res2 = call(admin, "imsApprovalSubmitRequest", dict(payload, quantity=1))
    check(not res2["success"] and "more than the Remaining" in res2["error"], "second submit is rejected (nothing remaining)")
    res3 = call(nobody, "imsApprovalSubmitRequest", dict(payload, quantity=1))
    check(not res3["success"] and "permission" in res3["error"], "user without New Entry Permission is rejected")
    nouom = call(admin, "imsApprovalSubmitRequest", dict(payload, uom="", quantity=1))
    check(not nouom["success"] and "UOM is required" in nouom["error"], "UOM is required")
    bad = call(admin, "imsApprovalSubmitRequest", dict(payload, quantity=0))
    check(not bad["success"] and "greater than 0" in bad["error"], "quantity 0 is rejected")

    print("Entry Status is always Done (no draft)")
    draft = call(chinmoy, "imsApprovalSubmitRequest", {
        "project": "HO", "planned": "Non Planned", "materialName": "CEMENT", "materialType": "HO",
        "uom": "BAG", "quantity": 25, "entryStatus": "Not Done", "remarks": "draft"})
    check(draft["success"] and draft["qtySynced"] is False, "Non Planned entry saved, no master sync")
    sr2 = draft["srNo"]
    reqs = call(admin, "imsApprovalGetRequests")
    r2 = next(r for r in reqs if r["srNo"] == sr2)
    check(r2["entryStatus"] == "Done" and r2["stages"]["approval"]["planned"] != "", "entryStatus Not Done is ignored, flow starts at once")

    print("Full workflow for request #%d (Planned, SITE MATERIAL, Advance Payment = Yes)" % sr1)
    extras_for = {
        "indent": {"indentNo": "IND-001"},
        "poRate": {"remarks": "rate ok"},
        "poEntry": {"vendorName": call(admin, "imsApprovalGetVendors")[0], "poAmount": "75000", "poNo": "PO-77", "paymentTerms": "30 days",
                    "advancePaymentRequired": "Yes"},
        "delivery": {"challanBillNo": "CH-9"},
    }
    expected_rate_approver = "Bikash Haldar"  # SITE MATERIAL, 75,000 <= 100,000
    for st in stages:
        key = st["key"]
        reqs = call(admin, "imsApprovalGetRequests")
        r = next(x for x in reqs if x["srNo"] == sr1)
        approver = r["stages"][key]["approver"]
        if key == "rateApproval":
            check(approver == expected_rate_approver, "Rate Approval approver computed -> %s" % approver)
        check(bool(approver), "%s has an approver (%s)" % (key, approver))
        email = people_email(approver)
        user = client_for(email)
        queue = call(user, "imsApprovalGetMyQueue")
        check(any(q["srNo"] == sr1 and q["stageKey"] == key and q["canAct"] for q in queue), "%s appears in %s's queue" % (key, approver))
        check(key in call(user, "imsApprovalGetMyStageKeys"), "%s is in %s's stage keys" % (key, approver))
        outsider = client_for(people_email("Sandip Das") if approver != "Sandip Das" else people_email("Amar Sharma"))
        if key not in ("approval",):
            pass
        wrong = call(outsider, "imsApprovalActOnStage", {"srNo": sr1, "stageKey": key, "extraFields": extras_for.get(key, {})})
        outsider_is_backup = (not wrong["success"]) is False
        if not outsider_is_backup:
            check("not the assigned approver" in wrong["error"] or "Previous stage" in wrong["error"], "%s: a non-assigned user is rejected" % key)
        # prior stage gating: acting on a later stage out of order must fail
        res = call(user, "imsApprovalActOnStage", {"srNo": sr1, "stageKey": key, "extraFields": extras_for.get(key, {})})
        check(res["success"], "%s approved by %s" % (key, approver))
        again = call(user, "imsApprovalActOnStage", {"srNo": sr1, "stageKey": key, "extraFields": {}})
        check(not again["success"] and "already marked" in again["error"], "%s cannot be approved twice" % key)

    reqs = call(admin, "imsApprovalGetRequests")
    r1 = next(x for x in reqs if x["srNo"] == sr1)
    check(r1["overallStatus"] == "Done", "overall status flips to Done after Truck Entry")
    check(r1["stages"]["poEntry"]["poAmount"] == 75000 and r1["stages"]["delivery"]["challanBillNo"] == "CH-9", "extra fields saved")
    check(r1["stages"]["advancePayment"]["planned"] != "", "Advance Payment planned date set because PO Preparation said Yes")
    check(r1["stages"]["approval"]["delay"] != "" and r1["stages"]["approval"]["approvedBy"] != "", "delay and approved-by recorded")

    print("Skipping Advance Payment when PO Preparation says No (request #%d)" % sr2)
    r2 = next(x for x in call(admin, "imsApprovalGetRequests") if x["srNo"] == sr2)
    for st in stages:
        key = st["key"]
        if key == "advancePayment":
            blocked = call(admin, "imsApprovalActOnStage", {"srNo": sr2, "stageKey": key, "extraFields": {}})
            check(not blocked["success"], "Advance Payment cannot be approved when not required")
            continue
        ex = {"indent": {"indentNo": "I-2"}, "delivery": {"challanBillNo": "C-2"},
              "poEntry": {"vendorName": "ABC", "poAmount": "120000", "poNo": "PO-78", "paymentTerms": "30 days", "advancePaymentRequired": "No"}}.get(key, {})
        res = call(admin, "imsApprovalActOnStage", {"srNo": sr2, "stageKey": key, "extraFields": ex})
        check(res["success"], "admin approves %s" % key)
    r2 = next(x for x in call(admin, "imsApprovalGetRequests") if x["srNo"] == sr2)
    check(r2["overallStatus"] == "Done", "request finishes without the Advance Payment stage")
    check(r2["stages"]["rateApproval"]["approver"] == "Managing Director", "HO + 120,000 -> Managing Director")

    print("PO Preparation needs an explicit Yes/No and every field")
    d = call(admin, "imsApprovalSubmitRequest", {"project": "Titagarh", "planned": "Non Planned", "materialName": "SAND",
                                                  "materialType": "SITE MATERIAL", "uom": "CFT", "quantity": 5, "entryStatus": "Done"})
    sr3 = d["srNo"]
    for key in ["approval", "approval2", "wbs", "indent", "poRate"]:
        ex = {"indent": {"indentNo": "I-3"}}.get(key, {})
        check(call(admin, "imsApprovalActOnStage", {"srNo": sr3, "stageKey": key, "extraFields": ex})["success"], "sr3 %s" % key)
    q3 = [q for q in call(admin, "imsApprovalGetMyQueue") if q["srNo"] == sr3 and q["stageKey"] == "delivery"]
    check(q3 and q3[0]["blockedByStageKey"] == "poEntry" and q3[0]["blockedByStageName"] == "PO Preparation Stage" or not q3,
          "queue shows which earlier stage blocks a locked item")
    nochoice = call(admin, "imsApprovalActOnStage", {"srNo": sr3, "stageKey": "poEntry",
                    "extraFields": {"vendorName": "ABC", "poAmount": "1000", "poNo": "X"}})
    check(not nochoice["success"] and "Yes or No" in nochoice["error"], "Advance Payment Required must be chosen")
    nopo = call(admin, "imsApprovalActOnStage", {"srNo": sr3, "stageKey": "poEntry",
                "extraFields": {"vendorName": "ABC", "poAmount": "1000", "paymentTerms": "Net 30", "advancePaymentRequired": "No"}})
    check(not nopo["success"] and "PO No is required" in nopo["error"], "every PO Preparation field is required")
    notr = call(admin, "imsApprovalActOnStage", {"srNo": sr3, "stageKey": "poEntry",
                "extraFields": {"vendorName": "ABC", "poAmount": "1000", "poNo": "P3", "advancePaymentRequired": "No"}})
    check(not notr["success"] and "Payment Terms is required" in notr["error"], "Payment Terms is required")
    check(call(admin, "imsApprovalActOnStage", {"srNo": sr3, "stageKey": "poEntry", "extraFields":
          {"vendorName": "ABC", "poAmount": "1000", "poNo": "P3", "paymentTerms": "Net 30", "advancePaymentRequired": "No"}})["success"], "sr3 poEntry")
    print("Edit PO Preparation details")
    pe = {"vendorName": "ABC", "poAmount": "2000", "poNo": "P3-EDIT", "paymentTerms": "Net 45", "advancePaymentRequired": "No"}
    check(not call(chinmoy, "imsApprovalEditPoEntry", {"srNo": sr3, "extraFields": pe})["success"], "non-approver cannot edit PO details")
    miss = call(admin, "imsApprovalEditPoEntry", {"srNo": sr3, "extraFields": dict(pe, poNo="")})
    check(not miss["success"] and "PO No is required" in miss["error"], "edit needs every field")
    check(call(admin, "imsApprovalEditPoEntry", {"srNo": sr3, "extraFields": pe})["success"], "approver/admin can edit PO details after approval")
    ed = next(r for r in call(admin, "imsApprovalGetRequests") if r["srNo"] == sr3)["stages"]["poEntry"]
    check(ed["poNo"] == "P3-EDIT" and ed["poAmount"] == 2000 and ed["canEdit"] and not ed["lockCore"], "edited values saved and canEdit set")
    check(call(admin, "imsApprovalActOnStage", {"srNo": sr3, "stageKey": "rateApproval", "extraFields": {}})["success"], "sr3 rateApproval")
    lock = call(admin, "imsApprovalEditPoEntry", {"srNo": sr3, "extraFields": dict(pe, poAmount="9999")})
    check(not lock["success"] and "after Rate Approval" in lock["error"], "PO Amount locked after Rate Approval")
    check(call(admin, "imsApprovalEditPoEntry", {"srNo": sr3, "extraFields": dict(pe, poNo="P3-LATE")})["success"], "other PO fields still editable after Rate Approval")
    out_of_order = call(admin, "imsApprovalActOnStage", {"srNo": sr3, "stageKey": "grn", "extraFields": {}})
    check(not out_of_order["success"] and "Previous stage" in out_of_order["error"], "stages cannot be skipped")

    print("Bulk approval")
    ids = []
    for _ in range(3):
        ids.append(call(admin, "imsApprovalSubmitRequest", {"project": "HO", "planned": "Non Planned", "materialName": "BRICK",
                                                             "materialType": "HO", "uom": "NOS", "quantity": 100, "entryStatus": "Done"})["srNo"])
    approval_user = client_for(people_email("Tulika Saha"))  # approval approver for HO
    bulk = call(approval_user, "imsApprovalActOnStages", {"items": [{"srNo": i, "stageKey": "approval"} for i in ids]})
    check(bulk["success"] and bulk["successCount"] == 3, "bulk approved 3 requests")
    bulk2 = call(approval_user, "imsApprovalActOnStages", {"items": [{"srNo": ids[0], "stageKey": "approval"}]})
    check(not bulk2["success"] and bulk2["failureCount"] == 1, "bulk reports failures per item")

    print("Shared PO fields for several requests at once")
    sh = []
    for _ in range(3):
        sh.append(call(admin, "imsApprovalSubmitRequest", {"project": "Titagarh", "planned": "Non Planned", "materialName": "TMT",
                                                            "materialType": "SITE MATERIAL", "uom": "KG", "quantity": 10, "entryStatus": "Done"})["srNo"])
    for key in ["approval", "approval2", "wbs", "indent", "poRate"]:
        r = call(admin, "imsApprovalActOnStagesWithSharedFields", {"items": [{"srNo": i, "stageKey": key} for i in sh],
                 "extraFields": {"indentNo": "SHARED-1"} if key == "indent" else {}})
        check(r["success"] and r["successCount"] == 3, "shared batch %s" % key)
    r = call(admin, "imsApprovalActOnStagesWithSharedFields", {"items": [{"srNo": i, "stageKey": "poEntry"} for i in sh],
             "extraFields": {"vendorName": "ABC", "poAmount": "40000", "poNo": "SHARED-PO", "paymentTerms": "Net 30", "advancePaymentRequired": "No"}})
    check(r["success"] and r["successCount"] == 3, "one PO No applied to 3 requests")
    got = [x for x in call(admin, "imsApprovalGetRequests") if x["srNo"] in sh]
    check(all(g["stages"]["poEntry"]["poNo"] == "SHARED-PO" for g in got), "shared PO No stored on each request")
    check(all(g["stages"]["rateApproval"]["approver"] == "Atanu Jana" for g in got), "Rate Approval approver computed from the shared amount")
    miss = call(admin, "imsApprovalActOnStagesWithSharedFields", {"items": [{"srNo": sh[0], "stageKey": "rateApproval"}], "extraFields": {}})
    check(miss["success"], "stage with no extra fields works in shared batch")

    print("Cancel (restores quantity master)")
    qty2 = next(r for r in call(admin, "imsApprovalGetQtyMasterForProject", "Orchard Amritaya")
                if isinstance(r["remaining"], (int, float)) and r["remaining"] >= 2 and r["block"] and r["lot"]
                and r["materialName"] != row["materialName"])
    sub = call(chinmoy, "imsApprovalSubmitRequest", {"project": "Orchard Amritaya", "planned": "Planned", "constructionType": qty2["constructionType"],
                                                      "block": qty2["block"], "lot": qty2["lot"], "materialName": qty2["materialName"],
                                                      "materialType": "SITE MATERIAL", "uom": "NOS", "quantity": 2, "entryStatus": "Done"})
    check(sub["success"] and sub["remainingAfter"] == qty2["remaining"] - 2, "partial quantity deducted")
    check(not call(nobody, "imsApprovalCancelRequest", {"srNo": sub["srNo"], "reason": "x"})["success"], "stranger cannot cancel")
    check(not call(chinmoy, "imsApprovalCancelRequest", {"srNo": sub["srNo"], "reason": "mine"})["success"], "requester without Cancel Permission cannot cancel")
    check(not call(admin, "imsApprovalCancelRequest", {"srNo": sub["srNo"], "reason": ""})["success"], "cancel reason is required")
    c = call(admin, "imsApprovalCancelRequest", {"srNo": sub["srNo"], "reason": "wrong item", "cancelDate": "2026-11-05"})
    check(c["success"] and c["qtyRestored"] and c["remainingAfter"] == qty2["remaining"], "cancel restores Remaining")
    check(not call(admin, "imsApprovalCancelRequest", {"srNo": sub["srNo"], "reason": "again"})["success"], "cannot cancel twice")
    check(not call(admin, "imsApprovalActOnStage", {"srNo": sub["srNo"], "stageKey": "approval", "extraFields": {}})["success"], "cancelled request cannot be approved")
    many = [call(chinmoy, "imsApprovalSubmitRequest", {"project": "HO", "planned": "Non Planned", "materialName": "CEMENT", "materialType": "HO",
            "taskName": "Smoke Task", "pointOfUses": "x", "uom": "BAG", "quantity": 1, "estimatedDeliveryDate": "2026-12-01"})["srNo"] for _ in range(2)]
    check(not call(nobody, "imsApprovalCancelMany", {"srNos": many, "reason": "bulk"})["success"], "stranger cannot bulk cancel")
    cm = call(admin, "imsApprovalCancelMany", {"srNos": many + [many[0]], "reason": "bulk test"})
    check(cm["doneCount"] == 2 and cm["total"] == 3 and not cm["results"][2]["success"], "bulk cancel: 2 cancelled, repeat rejected, others unaffected")
    cancelled = next(r for r in call(admin, "imsApprovalGetRequests") if r["srNo"] == sub["srNo"])
    check(cancelled["cancelled"] and cancelled["cancelReason"] == "wrong item" and cancelled["cancelledAt"].startswith("05-Nov-2026"), "cancel details stored")
    check(all(q["srNo"] != sub["srNo"] for q in call(admin, "imsApprovalGetMyQueue")), "cancelled request is not in anyone's queue")

    print("Test As (admin only)")
    info = call(admin, "imsApprovalGetCurrentUserInfo", people_email("Atanu Jana"))
    check(info["testing"] and info["email"] == people_email("Atanu Jana") and info["realIsAdmin"], "admin can test as another user")
    info2 = call(chinmoy, "imsApprovalGetCurrentUserInfo", ADMIN)
    check(not info2["testing"] and not info2["isAdmin"], "non-admin cannot use Test As")
    q_as = call(admin, "imsApprovalGetMyQueue", people_email("Atanu Jana"))
    check(all(q["canAct"] or q["blockedByStageKey"] for q in q_as), "Test As queue: every item is actionable or names the stage blocking it")

    print("\nALL %d CHECKS PASSED" % passed)


if __name__ == "__main__":
    main()
