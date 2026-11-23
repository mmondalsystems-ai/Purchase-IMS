"""
Static configuration for the IMS Purchase Approval Tracker.

This mirrors the constants at the top of the original Approval_Code.gs
(projects, stage definitions, rate approval rules, access types).
Edit them here when the business rules change, then redeploy.
"""
import os
from pathlib import Path
from zoneinfo import ZoneInfo

BASE_DIR = Path(__file__).resolve().parent

APP_TZ = ZoneInfo(os.getenv("APP_TIMEZONE", "Asia/Kolkata"))

PROJECTS = [
    "Orchard Amritaya", "Orchard Anantaa", "Newtown Rajarhat",
    "Orchard Avaasa", "Titagarh", "HO",
]

# Order matters: it is the workflow sequence.
STAGE_DEFS = [
    {"key": "approval", "name": "Approval Stage"},
    {"key": "approval2", "name": "2nd Approval Stage"},
    {"key": "wbs", "name": "WBS Stage"},
    {"key": "indent", "name": "Indent Stage",
     "extra": [{"key": "indentNo", "label": "Indent No"}]},
    {"key": "poRate", "name": "PO Rate Stage",
     "extra": [{"key": "remarks", "label": "Remarks"}]},
    {"key": "poEntry", "name": "PO Preparation Stage",
     "extra": [
         {"key": "vendorName", "label": "Vendor Name", "dropdown": "vendor"},
         {"key": "poAmount", "label": "PO Amount"},
         {"key": "poNo", "label": "PO No"},
         {"key": "paymentTerms", "label": "Payment Terms"},
         {"key": "advancePaymentRequired", "label": "Advance Payment Required"},
     ]},
    {"key": "rateApproval", "name": "Rate Approval Stage", "computedApprover": True},
    {"key": "advancePayment", "name": "Advance Payment Stage", "conditional": True},
    {"key": "delivery", "name": "Delivery Stage",
     "extra": [{"key": "challanBillNo", "label": "Challan No./Bill No."}]},
    {"key": "grn", "name": "GRN Stage"},
    {"key": "truckEntry", "name": "Truck Entry Stage"},
]

INF = float("inf")

# Rate Approval approver: computed from Material Type + PO Amount (not project).
RATE_APPROVAL_RULES = [
    {"materialType": "SITE MATERIAL", "maxAmount": 50000, "approver": "Atanu Jana"},
    {"materialType": "SITE MATERIAL", "maxAmount": 100000, "approver": "Bikash Haldar"},
    {"materialType": "SITE MATERIAL", "maxAmount": INF, "approver": "Managing Director"},
    {"materialType": "HO", "maxAmount": 100000, "approver": "Amar Sharma"},
    {"materialType": "HO", "maxAmount": INF, "approver": "Managing Director"},
]

MATERIAL_TYPES = [
    "SITE MATERIAL", "IT MATERIAL", "HR & ADMIN MATERIAL",
    "SALES & MARKETING MATERIAL", "ACCOUNTS MATERIAL", "LEGAL MATERIAL",
]

# Approval Stage approver is decided by Material Type (not by project).
# "HO" is the old material type of earlier entries; it keeps using the project-wise Stage Config approver.
APPROVAL_STAGE_BY_MATERIAL_TYPE = {
    "SITE MATERIAL": "Bikash Haldar",
    "IT MATERIAL": "Deepan Mukherjee",
    "HR & ADMIN MATERIAL": "Bondita Phukon",
    "SALES & MARKETING MATERIAL": "Purbasha Mukherjee Chakraborty",
    "ACCOUNTS MATERIAL": "Amar Sharma",
    "LEGAL MATERIAL": "Abhradeep Sinha",
}

ACCESS_TYPES = {
    "newEntry": "New Entry Permission",
    "cancel": "Cancel Permission",
    "backup": "Backup Approver",
}


def _csv_env(name: str, default: str = "") -> list:
    raw = os.getenv(name, default) or ""
    return [v.strip().lower() for v in raw.split(",") if v.strip()]


# Admins see every stage and can act on any stage (same as IMSAPPROVAL_ADMIN_EMAILS).
ADMIN_EMAILS = _csv_env("ADMIN_EMAILS", "bnaskar.systems@oswalgroup.net")

# Users who get the extra "Generate Report" page (Non Planned report). Nobody else sees it.
REPORT_EMAILS = _csv_env("REPORT_EMAILS", "tsaha.purchase@oswalgroup.net")
