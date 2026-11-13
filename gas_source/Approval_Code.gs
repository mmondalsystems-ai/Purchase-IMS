/**
 * RUN THIS ONE FUNCTION FIRST — select "RUN_ME_SETUP_QTY_AUTOFILL" in the function
 * dropdown at the top of the Apps Script editor (it's the very first one listed,
 * alphabetically at the top), then click Run. One-time only — installs the trigger
 * that auto-fills "Remaining" from "Total Qty (Fixed)" on Material Quantity Master.
 * Safe to run more than once if you're ever unsure whether it's already installed.
 */
function RUN_ME_SETUP_QTY_AUTOFILL() {
  imsApprovalInstallQtyMasterAutoFillTrigger_();
}

/**
 * IMS PURCHASE APPROVAL TRACKER
 * Standalone 12-stage sequential approval workflow, with PROJECT-WISE approvers.
 *
 * Sheets used (auto-created inside this spreadsheet on first run):
 *   - "Stage Config"              -> grid of Stage x Project -> Approver Name (pre-seeded)
 *   - "Access Control"            -> list of users who can raise/cancel/act as backup
 *   - "People"                    -> Approver Name -> Email lookup (fill this in!)
 *   - "Approval Tracker"          -> one row per request, all stage data in wide columns
 *   - "Material Quantity Master"  -> your BOQ-style reference data (Material Status,
 *                                     Construction Type, Block, LOT, Material Name,
 *                                     Total Qty (Fixed), Remaining, Project). You paste/
 *                                     import your own data into this tab. New Entry
 *                                     submissions look up a row here by
 *                                     Project + Construction Type + Block + LOT + Material Name
 *                                     and subtract the submitted Quantity from Remaining.
 *
 * SELF-HEALING STRUCTURE:
 * All sheets are synced by COLUMN/ROW NAME, not fixed position. If you add a new
 * stage, a new project, or a new extra field in this file and then run
 * "IMS Approval Tracker > Sync Sheet Structure" from the menu (or just Run Setup again),
 * only the missing rows/columns get appended — nothing existing is ever moved, renamed,
 * or overwritten. Safe to run as many times as you like.
 *
 * COLUMN ORDER ON THE "Approval Tracker" SHEET now matches the order fields appear in
 * the New Entry form (Sr No, Project, Construction Type, Block, LOT, Material Name,
 * Material Type, Quantity, Estimated Delivery Date, Status, Entry Status, Cancelled,
 * Cancelled By, Cancelled At, Cancel Reason, UserEmail, Remarks, Entry Timestamp),
 * because that's the order IMSAPPROVAL_BASE_HEADERS is defined in below and columns
 * are appended in that order the first time each is created. Columns that already
 * exist in an older sheet are never moved — this ordering only applies going forward
 * / to brand-new columns.
 *
 * WORKFLOW STAGES (in order): Approval, 2nd Approval, WBS, Indent, PO Rate, PO Entry
 * (Vendor Name + PO Amount), Rate Approval (computed from Material Type + PO Amount —
 * resolvable right away since PO Entry, which supplies PO Amount, comes immediately
 * before it), PO making (PO No + Advance Payment Required), Advance Payment
 * (conditional), Delivery, GRN, Truck Entry.
 *
 * SETUP:
 * 1. Set SS_ID below (or leave '' if this script is container-bound to your sheet).
 * 2. Deploy as web app: Execute as "Me" (the script owner) — NOT "User accessing the
 *    web app", since your team doesn't have direct access to this Sheet. Access:
 *    "Anyone within [domain]". Each person's identity for approver-matching still
 *    resolves correctly under this setting, as long as everyone is in the same
 *    Google Workspace domain.
 * 3. Run the "IMS Approval Tracker > Run Setup" menu (see Setup.gs).
 * 4. Go to the "People" tab and fill in the Email column for every name.
 * 5. Go to the "Material Quantity Master" tab and paste in your BOQ/quantity data.
 * 6. Rate Approval Stage's approver is NOT project-based — it's computed from
 *    Material Type + PO Amount (see IMSAPPROVAL_RATE_APPROVAL_RULES below).
 */

var IMSAPPROVAL_SS_ID = ''; // leave '' to use the bound spreadsheet
var IMSAPPROVAL_CONFIG_SHEET = 'Stage Config';
var IMSAPPROVAL_ACCESS_SHEET = 'Access Control';
var IMSAPPROVAL_PEOPLE_SHEET = 'People';
var IMSAPPROVAL_TRACKER_SHEET = 'Approval Tracker';
var IMSAPPROVAL_VENDOR_SHEET = 'Vendor Master';
var IMSAPPROVAL_MATERIAL_SHEET = 'Material Master';
var IMSAPPROVAL_QTY_SHEET = 'Material Quantity Master';
var IMSAPPROVAL_MASTER_ADMIN_SHEET = 'Master Data Admins';

var IMSAPPROVAL_PROJECTS = [
  'Orchard Amritaya', 'Orchard Anantaa', 'Newtown Rajarhat',
  'Orchard Avaasa', 'Titagarh', 'HO'
];

// Order matters for WORKFLOW SEQUENCE only. Column position in the sheet is independent
// of this order (see "SELF-HEALING STRUCTURE" above) — reordering this array never
// reshuffles existing sheet columns; it only affects gating/cascade logic.
var IMSAPPROVAL_STAGE_DEFS = [
  { key: 'approval',       name: 'Approval Stage' },
  { key: 'approval2',      name: '2nd Approval Stage' },
  { key: 'wbs',            name: 'WBS Stage' },
  { key: 'indent',         name: 'Indent Stage',
    extra: [{ key: 'indentNo', label: 'Indent No' }] },
  { key: 'poRate',         name: 'PO Rate Stage',
    extra: [
      { key: 'remarks', label: 'Remarks' }
    ] },
  { key: 'poEntry',        name: 'PO Preparation Stage',
    extra: [
      { key: 'vendorName', label: 'Vendor Name', dropdown: 'vendor' },
      { key: 'poAmount', label: 'PO Amount' },
      { key: 'poNo', label: 'PO No' },
      { key: 'paymentTerms', label: 'Payment Terms' },
      { key: 'advancePaymentRequired', label: 'Advance Payment Required' } // 'Yes' / 'No'
    ] },
  { key: 'rateApproval',   name: 'Rate Approval Stage', computedApprover: true },
  { key: 'advancePayment', name: 'Advance Payment Stage', conditional: true },
  { key: 'delivery',       name: 'Delivery Stage',
    extra: [{ key: 'challanBillNo', label: 'Challan No./Bill No.' }] },
  { key: 'grn',            name: 'GRN Stage' },
  { key: 'truckEntry',     name: 'Truck Entry Stage' }
];

// Rate Approval Stage approver — computed from Material Type + PO Amount, NOT project.
// Edit these thresholds/names here if the business rule changes.
var IMSAPPROVAL_RATE_APPROVAL_RULES = [
  { materialType: 'SITE MATERIAL', maxAmount: 50000,  approver: 'Atanu Jana' },
  { materialType: 'SITE MATERIAL', maxAmount: 100000, approver: 'Bikash Haldar' },
  { materialType: 'SITE MATERIAL', maxAmount: Infinity, approver: 'Managing Director' },
  { materialType: 'HO',            maxAmount: 100000, approver: 'Amar Sharma' },
  { materialType: 'HO',            maxAmount: Infinity, approver: 'Managing Director' }
];

var IMSAPPROVAL_MATERIAL_TYPES = ['SITE MATERIAL', 'HO'];

// Access Control rows are NOT workflow stages. They are shared permission lists where
// comma-separated Access Type, Project, Stage Key, and Names / Emails values can grant
// the same access to many people across many projects/stages in one row.
var IMSAPPROVAL_ACCESS_TYPES = {
  newEntry: 'New Entry Permission',
  cancel: 'Cancel Permission',
  backup: 'Backup Approver'
};
var IMSAPPROVAL_ACCESS_HEADERS = ['Access Type(s)', 'Project(s)', 'Stage Key(s) (backup only)', 'Notes', 'Names / Emails (comma-separated)'];

// Admins can SEE every stage's full detail on every request (bypasses the per-viewer
// "Restricted" placeholder), regardless of whether they're the assigned approver.
// This does NOT grant them approval rights on stages they aren't assigned to.
var IMSAPPROVAL_ADMIN_EMAILS = ['bnaskar.systems@oswalgroup.net','mmondal.systems@oswalgroup.net'];

// Base (non-stage) columns on the Approval Tracker sheet, IN THE ORDER THEY ARE
// APPENDED THE FIRST TIME EACH IS CREATED — this is also the order they appear in
// the New Entry form. Construction Type / Block / LOT / Quantity are new.
var IMSAPPROVAL_BASE_HEADERS = [
  'Sr No', 'Project', 'Planned', 'Construction Type', 'Block', 'LOT', 'Material Name',
  'Material Type', 'UOM', 'Quantity', 'Estimated Delivery Date', 'Status', 'Entry Status',
  'Cancelled', 'Cancelled By', 'Cancelled At', 'Cancel Reason',
  'UserEmail', 'Remarks', 'Entry Timestamp'
];
var IMSAPPROVAL_STAGE_SUBCOLS = ['Approver', 'Planned Date', 'Actual Date', 'Delay (days)', 'Status', 'Approved By'];

// Pre-seeded approver grid, exactly as specified. Stage Config tab is built from this on first run.
var IMSAPPROVAL_SEED_APPROVERS = {
  approval:       { 'Orchard Amritaya': 'Bikash Haldar', 'Orchard Anantaa': 'Bikash Haldar', 'Newtown Rajarhat': 'Bikash Haldar', 'Orchard Avaasa': 'Bikash Haldar', 'Titagarh': 'Bikash Haldar', 'HO': 'Tulika Saha' },
  approval2:      { 'Orchard Amritaya': 'Somnath Mondal', 'Orchard Anantaa': 'Somnath Mondal', 'Newtown Rajarhat': 'Somnath Mondal', 'Orchard Avaasa': 'Somnath Mondal', 'Titagarh': 'Somnath Mondal', 'HO': 'Rishabh Prajapati' },
  wbs:            { 'Orchard Amritaya': 'Atanu Jana', 'Orchard Anantaa': 'Atanu Jana', 'Newtown Rajarhat': 'Atanu Jana', 'Orchard Avaasa': 'Sourav Mondal', 'Titagarh': 'Atanu Jana', 'HO': 'Atanu Jana' },
  indent:         { 'Orchard Amritaya': 'Pradip Acharya', 'Orchard Anantaa': 'Ashish Halder', 'Newtown Rajarhat': 'Bappaditya Ghosh', 'Orchard Avaasa': 'Subhodip Neogi', 'Titagarh': 'Pritam Hazra', 'HO': 'Pradip Acharya' },
  poRate:         { 'Orchard Amritaya': 'Rishabh Prajapati', 'Orchard Anantaa': 'Rishabh Prajapati', 'Newtown Rajarhat': 'Rishabh Prajapati', 'Orchard Avaasa': 'Rishabh Prajapati', 'Titagarh': 'Rishabh Prajapati', 'HO': 'Rishabh Prajapati' },
  poEntry:        { 'Orchard Amritaya': 'Moumita Sasmal', 'Orchard Anantaa': 'Tulika Saha', 'Newtown Rajarhat': 'Tulika Saha', 'Orchard Avaasa': 'Moumita Sasmal', 'Titagarh': 'Moumita Sasmal', 'HO': 'Tulika Saha' },
  advancePayment: { 'Orchard Amritaya': 'Sandip Das', 'Orchard Anantaa': 'Sandip Das', 'Newtown Rajarhat': 'Sandip Das', 'Orchard Avaasa': 'Sandip Das', 'Titagarh': 'Sandip Das', 'HO': 'Sandip Das' },
  delivery:       { 'Orchard Amritaya': 'Pradip Acharya', 'Orchard Anantaa': 'Ashish Halder', 'Newtown Rajarhat': 'Suman Pradhan', 'Orchard Avaasa': 'Ashish Halder', 'Titagarh': 'Pritam Hazra', 'HO': 'Pradip Acharya' },
  grn:            { 'Orchard Amritaya': 'Asish Adhikary', 'Orchard Anantaa': 'Ashish Halder', 'Newtown Rajarhat': 'Suman Pradhan', 'Orchard Avaasa': 'Ashish Halder', 'Titagarh': 'Pritam Hazra', 'HO': 'Asish Adhikary' },
  truckEntry:     { 'Orchard Amritaya': 'Asish Adhikary', 'Orchard Anantaa': 'Ashish Halder', 'Newtown Rajarhat': 'Suman Pradhan', 'Orchard Avaasa': 'Ashish Halder', 'Titagarh': 'Pritam Hazra', 'HO': 'Asish Adhikary' }
};

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

function doGet(e) {
  return HtmlService.createTemplateFromFile('ApprovalIndex')
    .evaluate()
    .setTitle('IMS Purchase Approval Tracker')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function imsApprovalInclude(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

function imsApprovalGetSs_() {
  return IMSAPPROVAL_SS_ID ? SpreadsheetApp.openById(IMSAPPROVAL_SS_ID) : SpreadsheetApp.getActiveSpreadsheet();
}

// ---------------------------------------------------------------------------
// Stage Config sheet: grid of Stage x Project -> Approver Name (editable, pre-seeded)
// Synced by NAME: existing rows/columns are never touched; only missing
// stage-rows or project-columns get appended.
// ---------------------------------------------------------------------------

function imsApprovalEnsureConfigSheet_() {
  var ss = imsApprovalGetSs_();
  var sheet = ss.getSheetByName(IMSAPPROVAL_CONFIG_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(IMSAPPROVAL_CONFIG_SHEET);
    sheet.appendRow(['Stage Order', 'Stage Key', 'Stage Name']);
    sheet.getRange(1, 1, 1, 3).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  imsApprovalSyncConfigSheet_(sheet);
  return sheet;
}

/**
 * Additive sync: appends any project columns and stage rows that don't exist yet.
 * Never modifies a cell that's already there.
 */
function imsApprovalSyncConfigSheet_(sheet) {
  var lastCol = Math.max(sheet.getLastColumn(), 3);
  var headerRow = sheet.getRange(1, 1, 1, lastCol).getValues()[0];

  // Ensure base header labels exist (only true on a hand-created/older sheet)
  if (!headerRow[0]) sheet.getRange(1, 1).setValue('Stage Order');
  if (!headerRow[1]) sheet.getRange(1, 2).setValue('Stage Key');
  if (!headerRow[2]) sheet.getRange(1, 3).setValue('Stage Name');

  // Map existing project column headers -> column index
  var projectCol = {};
  for (var c = 4; c <= lastCol; c++) {
    if (headerRow[c - 1]) projectCol[headerRow[c - 1]] = c;
  }

  // Append any missing project columns (header only for now — existing rows get backfilled below)
  var nextCol = lastCol + 1;
  var newlyAddedProjectCols = [];
  IMSAPPROVAL_PROJECTS.forEach(function (proj) {
    if (!projectCol[proj]) {
      sheet.getRange(1, nextCol).setValue(proj).setFontWeight('bold')
        .setBackground('#1e3f73').setFontColor('#ffffff');
      projectCol[proj] = nextCol;
      newlyAddedProjectCols.push(proj);
      nextCol++;
    }
  });

  // Map existing stage rows (by Stage Key in column B) -> row index
  var lastRow = sheet.getLastRow();
  var stageRow = {};
  if (lastRow >= 2) {
    var keys = sheet.getRange(2, 2, lastRow - 1, 1).getValues();
    keys.forEach(function (row, i) { if (row[0]) stageRow[row[0]] = i + 2; });
  }

  // Append any missing stage rows entirely, seeded across ALL current project columns
  var nextRow = Math.max(lastRow, 1) + 1;
  var newlyAddedStageKeys = {};
  IMSAPPROVAL_STAGE_DEFS.forEach(function (stage, idx) {
    if (stageRow[stage.key]) return; // already present — leave entirely untouched
    sheet.getRange(nextRow, 1, 1, 3).setValues([[idx + 1, stage.key, stage.name]]);
    imsApprovalFillStageConfigRowCells_(sheet, nextRow, stage, projectCol);
    stageRow[stage.key] = nextRow;
    newlyAddedStageKeys[stage.key] = true;
    nextRow++;
  });

  // Backfill the newly-added project columns for stage rows that ALREADY existed
  // (those cells are brand new / were never there, so seeding them is safe and desired)
  if (newlyAddedProjectCols.length) {
    IMSAPPROVAL_STAGE_DEFS.forEach(function (stage) {
      var r = stageRow[stage.key];
      if (!r || newlyAddedStageKeys[stage.key]) return; // brand-new rows already fully seeded above
      var onlyNewCols = {};
      newlyAddedProjectCols.forEach(function (proj) { onlyNewCols[proj] = projectCol[proj]; });
      imsApprovalFillStageConfigRowCells_(sheet, r, stage, onlyNewCols);
    });
  }

  sheet.autoResizeColumns(1, nextCol - 1);
}

function imsApprovalFillStageConfigRowCells_(sheet, row, stage, projectColSubset) {
  if (stage.computedApprover) {
    Object.keys(projectColSubset).forEach(function (proj) {
      sheet.getRange(row, projectColSubset[proj]).setValue('(computed — see Rate Approval logic in code)')
        .setFontStyle('italic').setBackground('#eceff1');
    });
  } else {
    var seed = IMSAPPROVAL_SEED_APPROVERS[stage.key] || {};
    Object.keys(projectColSubset).forEach(function (proj) {
      sheet.getRange(row, projectColSubset[proj]).setValue(seed[proj] || '').setBackground('#fffde7');
    });
  }
}

/** Reads Stage Config -> map: stageKey -> { name, byProject: { projectName: approverName } } */
function imsApprovalGetStageConfig_() {
  var sheet = imsApprovalEnsureConfigSheet_();
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  var map = {};
  if (lastRow < 2 || lastCol < 4) return map;

  var headerRow = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var projectColIdx = []; // [{name, col}]
  for (var c = 4; c <= lastCol; c++) {
    if (headerRow[c - 1]) projectColIdx.push({ name: headerRow[c - 1], col: c });
  }

  var values = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  values.forEach(function (row) {
    var key = row[1];
    if (!key) return;
    var byProject = {};
    projectColIdx.forEach(function (p) {
      byProject[p.name] = (row[p.col - 1] || '').toString().trim();
    });
    map[key] = { order: row[0], name: row[2] || key, byProject: byProject };
  });
  return map;
}

/**
 * Same shape as imsApprovalGetStageConfig_(), but reads whatever's already on the sheet
 * without calling imsApprovalEnsureConfigSheet_() first — no sync, no writes, just a read.
 * Use this (or pass a pre-fetched map into imsApprovalGetApproverName_) anywhere the lookup
 * happens in a loop (e.g. once per stage per request), since the syncing version is expensive
 * and only needs to run once per page action, not once per stage.
 */
function imsApprovalReadStageConfigOnly_() {
  var ss = imsApprovalGetSs_();
  var sheet = ss.getSheetByName(IMSAPPROVAL_CONFIG_SHEET);
  var map = {};
  if (!sheet) return map;
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow < 2 || lastCol < 4) return map;

  var headerRow = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var projectColIdx = [];
  for (var c = 4; c <= lastCol; c++) {
    if (headerRow[c - 1]) projectColIdx.push({ name: headerRow[c - 1], col: c });
  }

  var values = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  values.forEach(function (row) {
    var key = row[1];
    if (!key) return;
    var byProject = {};
    projectColIdx.forEach(function (p) {
      byProject[p.name] = (row[p.col - 1] || '').toString().trim();
    });
    map[key] = { order: row[0], name: row[2] || key, byProject: byProject };
  });
  return map;
}

// ---------------------------------------------------------------------------
// Access Control sheet: comma-separated Access Type(s), Project(s), Stage Key(s),
// and Names / Emails. Stage Config remains only for the primary visible stage approver.
// ---------------------------------------------------------------------------

function imsApprovalEnsureAccessSheet_() {
  var ss = imsApprovalGetSs_();
  var sheet = ss.getSheetByName(IMSAPPROVAL_ACCESS_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(IMSAPPROVAL_ACCESS_SHEET);
    sheet.appendRow(IMSAPPROVAL_ACCESS_HEADERS);
    sheet.getRange(1, 1, 1, IMSAPPROVAL_ACCESS_HEADERS.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  imsApprovalSyncAccessSheet_(sheet);
  return sheet;
}

function imsApprovalSyncAccessSheet_(sheet) {
  var width = IMSAPPROVAL_ACCESS_HEADERS.length;
  IMSAPPROVAL_ACCESS_HEADERS.forEach(function (header, idx) {
    sheet.getRange(1, idx + 1).setValue(header);
  });

  var lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    var currentRows = sheet.getRange(2, 1, lastRow - 1, width).getValues();
    var hasAnyAccessRows = currentRows.some(function (row) {
      return row.some(function (cell) { return (cell || '').toString().trim(); });
    });
    if (hasAnyAccessRows) {
      sheet.autoResizeColumns(1, width);
      return;
    }
  }

  var nextRow = Math.max(lastRow, 1) + 1;
  var allProjects = IMSAPPROVAL_PROJECTS.join(', ');
  var seedRows = [
    [IMSAPPROVAL_ACCESS_TYPES.newEntry, allProjects, '', 'Stage not needed', ''],
    [IMSAPPROVAL_ACCESS_TYPES.cancel, allProjects, '', 'Stage not needed', ''],
    [IMSAPPROVAL_ACCESS_TYPES.backup, allProjects, 'ALL', 'All stages', '']
  ];

  seedRows.forEach(function (row) {
    sheet.getRange(nextRow, 1, 1, width).setValues([row]);
    sheet.getRange(nextRow, 5).setBackground('#fffde7');
    nextRow++;
  });

  sheet.autoResizeColumns(1, width);
}

function imsApprovalNormalizeAccessType_(value) {
  var v = (value || '').toString().trim();
  var lower = v.toLowerCase();
  if (!lower) return '';
  if (lower === IMSAPPROVAL_ACCESS_TYPES.newEntry.toLowerCase() ||
      lower === 'new entry' ||
      lower === 'request' ||
      lower === 'requestpermission' ||
      lower === 'request permission' ||
      lower === 'raise new request' ||
      lower === 'raise purchase request' ||
      lower === 'new purchase request') {
    return IMSAPPROVAL_ACCESS_TYPES.newEntry;
  }
  if (lower === IMSAPPROVAL_ACCESS_TYPES.cancel.toLowerCase() ||
      lower === 'cancel' ||
      lower === 'cancelpermission' ||
      lower === 'cancel request') {
    return IMSAPPROVAL_ACCESS_TYPES.cancel;
  }
  if (lower === IMSAPPROVAL_ACCESS_TYPES.backup.toLowerCase() ||
      lower === 'backup' ||
      lower === 'backup approvers' ||
      lower === 'backup approval') {
    return IMSAPPROVAL_ACCESS_TYPES.backup;
  }
  return v;
}

function imsApprovalParseAccessTypeList_(value) {
  return imsApprovalParseNameList_(value)
    .map(function (type) { return imsApprovalNormalizeAccessType_(type); })
    .filter(function (type) { return !!type; });
}

function imsApprovalNormalizeAccessProject_(value) {
  var v = (value || '').toString().trim();
  var lower = v.toLowerCase();
  if (!lower) return '';
  if (lower === 'all' || lower === 'all projects' || lower === '*' || lower === 'any') return 'ALL';
  for (var i = 0; i < IMSAPPROVAL_PROJECTS.length; i++) {
    if (IMSAPPROVAL_PROJECTS[i].toLowerCase() === lower) return IMSAPPROVAL_PROJECTS[i];
  }
  return v;
}

function imsApprovalParseAccessProjectList_(value) {
  return imsApprovalParseNameList_(value)
    .map(function (project) { return imsApprovalNormalizeAccessProject_(project); })
    .filter(function (project) { return !!project; });
}

function imsApprovalNormalizeAccessStageKey_(value) {
  var v = (value || '').toString().trim();
  var lower = v.toLowerCase();
  if (!lower || lower === 'all' || lower === 'all stages' || lower === '*' || lower === 'any') return 'ALL';
  for (var i = 0; i < IMSAPPROVAL_STAGE_DEFS.length; i++) {
    var stage = IMSAPPROVAL_STAGE_DEFS[i];
    if (stage.key.toLowerCase() === lower || stage.name.toLowerCase() === lower) return stage.key;
  }
  return v;
}

function imsApprovalParseAccessStageKeyList_(value) {
  var raw = (value === null || value === undefined || value === '') ? 'ALL' : value;
  return imsApprovalParseNameList_(raw)
    .map(function (stageKey) { return imsApprovalNormalizeAccessStageKey_(stageKey); })
    .filter(function (stageKey) { return !!stageKey; });
}

function imsApprovalAccessRowKey_(accessType, project, stageKey) {
  return [
    imsApprovalNormalizeAccessType_(accessType).toLowerCase(),
    imsApprovalNormalizeAccessProject_(project).toLowerCase(),
    imsApprovalNormalizeAccessStageKey_(stageKey).toLowerCase()
  ].join('|');
}

/** Reads Access Control and syncs missing seed rows first. */
function imsApprovalGetAccessConfig_() {
  var sheet = imsApprovalEnsureAccessSheet_();
  return imsApprovalReadAccessSheet_(sheet);
}

/** Pure read (no sync/write) of Access Control — use this in loops. */
function imsApprovalReadAccessConfigOnly_() {
  var ss = imsApprovalGetSs_();
  var sheet = ss.getSheetByName(IMSAPPROVAL_ACCESS_SHEET);
  if (!sheet) return {};
  return imsApprovalReadAccessSheet_(sheet);
}

function imsApprovalReadAccessSheet_(sheet) {
  var lastRow = sheet.getLastRow();
  var map = {};
  if (lastRow < 2) return map;

  var width = IMSAPPROVAL_ACCESS_HEADERS.length;
  var values = sheet.getRange(2, 1, lastRow - 1, width).getValues();
  values.forEach(function (row) {
    var accessTypes = imsApprovalParseAccessTypeList_(row[0]);
    var projects = imsApprovalParseAccessProjectList_(row[1]);
    var stageKeys = imsApprovalParseAccessStageKeyList_(row[2]);
    var users = (row[4] || '').toString().trim();
    if (!accessTypes.length || !projects.length || !stageKeys.length || !users) return;
    accessTypes.forEach(function (accessType) {
      var effectiveStageKeys = (accessType === IMSAPPROVAL_ACCESS_TYPES.backup) ? stageKeys : ['ALL'];
      projects.forEach(function (project) {
        effectiveStageKeys.forEach(function (stageKey) {
          var key = imsApprovalAccessRowKey_(accessType, project, stageKey);
          if (!map[key]) map[key] = [];
          map[key].push(users);
        });
      });
    });
  });
  return map;
}

function imsApprovalGetAccessEmails_(accessType, project, stageKey, accessConfigMap, peopleMap) {
  var type = imsApprovalNormalizeAccessType_(accessType);
  var config = accessConfigMap || imsApprovalGetAccessConfig_();
  var stage = imsApprovalNormalizeAccessStageKey_(stageKey);
  var projects = [];
  var stages = [];
  var rawValues = [];

  if (project) projects.push(imsApprovalNormalizeAccessProject_(project));
  projects.push('ALL'); // Optional manual row for access across every project.
  stages.push(stage);
  if (stage.toLowerCase() !== 'all') stages.push('ALL');

  projects.forEach(function (projectName) {
    stages.forEach(function (stageName) {
      var values = config[imsApprovalAccessRowKey_(type, projectName, stageName)] || [];
      rawValues = rawValues.concat(values);
    });
  });

  var seen = {};
  return imsApprovalResolveEmails_(rawValues.join(','), peopleMap).filter(function (email) {
    if (seen[email]) return false;
    seen[email] = true;
    return true;
  });
}

// ---------------------------------------------------------------------------
// Vendor Master & Material Master: simple name lists, dropdown-backed
// ---------------------------------------------------------------------------

function imsApprovalEnsureVendorSheet_() {
  var ss = imsApprovalGetSs_();
  var sheet = ss.getSheetByName(IMSAPPROVAL_VENDOR_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(IMSAPPROVAL_VENDOR_SHEET);
    sheet.appendRow(['Vendor Name', 'Added On']);
    sheet.getRange(1, 1, 1, 2).setBackground('#1e3f73').setFontColor('#ffffff').setFontWeight('bold');
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(1, 260);
    sheet.setColumnWidth(2, 160);
  }
  return sheet;
}

function imsApprovalEnsureMaterialSheet_() {
  var ss = imsApprovalGetSs_();
  var sheet = ss.getSheetByName(IMSAPPROVAL_MATERIAL_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(IMSAPPROVAL_MATERIAL_SHEET);
    sheet.appendRow(['Material Name', 'Added On']);
    sheet.getRange(1, 1, 1, 2).setBackground('#1e3f73').setFontColor('#ffffff').setFontWeight('bold');
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(1, 260);
    sheet.setColumnWidth(2, 160);
  }
  return sheet;
}

function imsApprovalGetVendors() {
  var sheet = imsApprovalEnsureVendorSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  return sheet.getRange(2, 1, lastRow - 1, 1).getValues()
    .map(function (r) { return r[0]; })
    .filter(function (v) { return v; })
    .sort();
}

function imsApprovalGetMaterials() {
  var sheet = imsApprovalEnsureMaterialSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  return sheet.getRange(2, 1, lastRow - 1, 1).getValues()
    .map(function (r) { return r[0]; })
    .filter(function (v) { return v; })
    .sort();
}

// ---------------------------------------------------------------------------
// Material Quantity Master sheet: YOUR BOQ-style reference data.
// Columns (in this order): Material Status, Construction Type, Block, LOT,
// Material Name, Total Qty (Fixed), Remaining, Project.
// You paste/import your own data here — nothing here is auto-generated.
// New Entry submissions look up a row by Project + Construction Type + Block +
// LOT + Material Name and subtract the submitted Quantity from Remaining.
// ---------------------------------------------------------------------------

// Your live sheet's actual column layout (Construction Type, Block, LOT, Material Name,
// UOM, Total Qty (Fixed), Remaining, Project — "Material Status" was removed and "UOM"
// was added). Every function below resolves columns by this header text, read fresh from
// row 1, rather than a hardcoded position — so if a column is ever added/reordered again,
// this keeps working instead of silently reading/writing the wrong column.
var IMSAPPROVAL_QTY_HEADERS = ['Construction Type', 'Block', 'LOT', 'Material Name', 'UOM', 'Total Qty (Fixed)', 'Remaining', 'Project'];

function imsApprovalEnsureQtyMasterSheet_() {
  var ss = imsApprovalGetSs_();
  var sheet = ss.getSheetByName(IMSAPPROVAL_QTY_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(IMSAPPROVAL_QTY_SHEET);
    sheet.appendRow(IMSAPPROVAL_QTY_HEADERS);
    sheet.getRange(1, 1, 1, IMSAPPROVAL_QTY_HEADERS.length).setBackground('#1e3f73').setFontColor('#ffffff').setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/** Resolves { constructionType, block, lot, materialName, uom, totalQty, remaining, project }
 * column numbers from the sheet's ACTUAL header row (never a fixed position). Any header
 * not found resolves to -1, which every caller below checks for. */
function imsApprovalGetQtyMasterColMap_(sheet) {
  var lastCol = sheet.getLastColumn();
  var headerRow = lastCol > 0 ? sheet.getRange(1, 1, 1, lastCol).getValues()[0] : [];
  var map = {};
  var want = {
    constructionType: 'Construction Type', block: 'Block', lot: 'LOT',
    materialName: 'Material Name', uom: 'UOM', totalQty: 'Total Qty (Fixed)',
    remaining: 'Remaining', project: 'Project'
  };
  Object.keys(want).forEach(function (key) {
    map[key] = -1;
    for (var c = 0; c < headerRow.length; c++) {
      if ((headerRow[c] || '').toString().trim() === want[key]) { map[key] = c + 1; break; }
    }
  });
  return map;
}

/** Reads every non-blank row of the Material Quantity Master sheet into plain objects. */
function imsApprovalGetQtyMasterRows_() {
  var sheet = imsApprovalEnsureQtyMasterSheet_();
  var lastRow = sheet.getLastRow();
  var colMap = imsApprovalGetQtyMasterColMap_(sheet);
  if (lastRow < 2 || colMap.materialName === -1 || colMap.project === -1) return [];
  var lastCol = sheet.getLastColumn();
  var values = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  var rows = [];
  values.forEach(function (r, i) {
    var get = function (key) { return colMap[key] === -1 ? '' : r[colMap[key] - 1]; };
    var materialName = (get('materialName') || '').toString().trim();
    var project = (get('project') || '').toString().trim();
    if (!materialName && !project) return; // skip fully blank rows
    rows.push({
      rowIndex: i + 2,
      constructionType: (get('constructionType') || '').toString().trim(),
      block: (get('block') || '').toString().trim(),
      lot: (get('lot') || '').toString().trim(),
      materialName: materialName,
      uom: (get('uom') || '').toString().trim(),
      totalQty: get('totalQty'),
      remaining: get('remaining'),
      project: project
    });
  });
  return rows;
}

/** Client-callable: Material Quantity Master rows scoped to one project (for cascading suggestions in New Entry). */
function imsApprovalGetQtyMasterForProject(project) {
  if (!project) return [];
  return imsApprovalGetQtyMasterRows_()
    .filter(function (r) { return r.project === project; })
    .map(function (r) {
      return {
        constructionType: r.constructionType, block: r.block,
        lot: r.lot, materialName: r.materialName, uom: r.uom, totalQty: r.totalQty, remaining: r.remaining
      };
    });
}

/** Finds the exact Material Quantity Master row for a combo, or null if not found. */
function imsApprovalFindQtyMasterRow_(project, constructionType, block, lot, materialName) {
  var rows = imsApprovalGetQtyMasterRows_();
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (r.constructionType === constructionType && r.block === block && r.lot === lot &&
        r.materialName === materialName && r.project === project) {
      return { rowIndex: r.rowIndex, remaining: Number(r.remaining) || 0, uom: r.uom };
    }
  }
  return null;
}

/**
 * Subtracts quantity from the matching Material Quantity Master row's Remaining.
 * Returns { synced: false } silently (no error) if no matching row is found — a
 * request can still be logged even if it isn't in your quantity master yet.
 */
function imsApprovalDeductQtyMaster_(project, constructionType, block, lot, materialName, quantity) {
  var match = imsApprovalFindQtyMasterRow_(project, constructionType, block, lot, materialName);
  if (!match) return { synced: false };
  var sheet = imsApprovalEnsureQtyMasterSheet_();
  var colMap = imsApprovalGetQtyMasterColMap_(sheet);
  if (colMap.remaining === -1) return { synced: false };
  var newRemaining = match.remaining - Number(quantity);
  sheet.getRange(match.rowIndex, colMap.remaining).setValue(newRemaining);
  return { synced: true, remaining: newRemaining, uom: match.uom };
}

/**
 * Reverse of imsApprovalDeductQtyMaster_ — adds quantity back to the matching
 * Material Quantity Master row's Remaining. Used when a request is cancelled.
 * Returns { synced: false } silently if no matching row is found (e.g. the combo
 * was never in the master to begin with, or the master row was since deleted).
 */
function imsApprovalRestoreQtyMaster_(project, constructionType, block, lot, materialName, quantity) {
  var match = imsApprovalFindQtyMasterRow_(project, constructionType, block, lot, materialName);
  if (!match) return { synced: false };
  var sheet = imsApprovalEnsureQtyMasterSheet_();
  var colMap = imsApprovalGetQtyMasterColMap_(sheet);
  if (colMap.remaining === -1) return { synced: false };
  var newRemaining = match.remaining + Number(quantity);
  sheet.getRange(match.rowIndex, colMap.remaining).setValue(newRemaining);
  return { synced: true, remaining: newRemaining };
}

/**
 * Auto-fills "Remaining" (col G) from "Total Qty (Fixed)" (col F) on the Material
 * Quantity Master sheet, for rows where F has a value but G is completely BLANK —
 * e.g. a brand-new row just pulled in by IMPORTRANGE that hasn't had its Remaining
 * set manually yet. A row whose Remaining is already 0 (fully used, by a request or
 * a manual edit) is intentionally left untouched — 0 is a real, meaningful value
 * here, not a "not yet filled" marker, and this must never overwrite it back to F.
 * Any other existing G value (partially used, manually adjusted) is also left alone —
 * only a truly empty cell gets filled. Safe to run as often as you like.
 */
function imsApprovalFillQtyMasterRemaining_() {
  var sheet = imsApprovalEnsureQtyMasterSheet_();
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow < 2 || lastCol < 1) return { filled: 0 };

  // Resolve "Total Qty (Fixed)" and "Remaining" by their ACTUAL header text, never by a
  // hardcoded column number — if a column was ever manually inserted/reordered on this
  // sheet, a fixed index (6, 7) would silently point at the wrong column and corrupt data.
  var headerRow = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var totalQtyCol = -1, remainingCol = -1;
  for (var c = 0; c < headerRow.length; c++) {
    var h = (headerRow[c] || '').toString().trim();
    if (h === 'Total Qty (Fixed)') totalQtyCol = c + 1;
    if (h === 'Remaining') remainingCol = c + 1;
  }
  if (totalQtyCol === -1 || remainingCol === -1) return { filled: 0, error: 'Header "Total Qty (Fixed)" or "Remaining" not found on Material Quantity Master — nothing changed.' };

  var totalQtyValues = sheet.getRange(2, totalQtyCol, lastRow - 1, 1).getValues();
  var remainingValues = sheet.getRange(2, remainingCol, lastRow - 1, 1).getValues();
  var filled = 0;

  for (var i = 0; i < totalQtyValues.length; i++) {
    var totalQty = totalQtyValues[i][0];
    var remaining = remainingValues[i][0];
    var hasTotalQty = totalQty !== '' && totalQty !== null && totalQty !== undefined;
    var remainingIsBlank = remaining === '' || remaining === null || remaining === undefined;
    if (hasTotalQty && remainingIsBlank) {
      remainingValues[i][0] = totalQty;
      filled++;
    }
  }

  // Write ONLY the Remaining column back — Total Qty (Fixed) is never touched, whatever happens.
  if (filled > 0) sheet.getRange(2, remainingCol, remainingValues.length, 1).setValues(remainingValues);
  return { filled: filled };
}

/** Menu-bound: runs the fill once right now and reports how many rows it touched. */
function imsApprovalFillQtyMasterRemainingNow() {
  var result = imsApprovalFillQtyMasterRemaining_();
  SpreadsheetApp.getUi().alert(
    'Filled "Remaining" for ' + result.filled + ' row(s) on "Material Quantity Master" where it was blank. ' +
    'Rows already showing 0 (or any other value) were left exactly as they were.'
  );
}

/** Installable trigger handler — fires on ANY change to the spreadsheet, including an
 * IMPORTRANGE refresh (which onEdit does NOT catch, since nothing was typed by a user). */
function imsApprovalOnQtyMasterChange_(e) {
  imsApprovalFillQtyMasterRemaining_();
}

/**
 * One-time setup: installs the onChange trigger above so new rows arriving via
 * IMPORTRANGE get their Remaining auto-filled automatically, with no manual step.
 * Safe to run more than once — it checks for an existing trigger first and skips
 * creating a duplicate. Run this once from the Apps Script editor (select
 * "imsApprovalInstallQtyMasterAutoFillTrigger_" in the function dropdown, then Run).
 */
function imsApprovalInstallQtyMasterAutoFillTrigger_() {
  var ss = imsApprovalGetSs_();
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'imsApprovalOnQtyMasterChange_') {
      Logger.log('Auto-fill trigger is already installed — nothing to do.');
      return;
    }
  }
  ScriptApp.newTrigger('imsApprovalOnQtyMasterChange_')
    .forSpreadsheet(ss)
    .onChange()
    .create();
  Logger.log('Auto-fill trigger installed. "Remaining" will now fill in automatically from "Total Qty (Fixed)" whenever a row\'s Remaining is blank and Total Qty has a value (including right after an IMPORTRANGE refresh).');
  imsApprovalFillQtyMasterRemaining_(); // also backfill any rows that are already sitting blank right now
}

// ---------------------------------------------------------------------------
// Client-callable: static stage config for rendering labels
// ---------------------------------------------------------------------------

function imsApprovalGetStageConfigForClient() {
  return IMSAPPROVAL_STAGE_DEFS.map(function (stage) {
    return {
      key: stage.key,
      name: stage.name,
      conditional: !!stage.conditional,
      computedApprover: !!stage.computedApprover,
      extra: stage.extra || [],
      statusValues: imsApprovalStatusValues_(stage.key)
    };
  });
}

function imsApprovalGetProjectsForClient() {
  return IMSAPPROVAL_PROJECTS;
}

/**
 * Client-callable: which projects the current user may raise a New Entry request for — used
 * to filter the Project chips on that page (everyone still has full view access everywhere
 * else; this only gates submitting new requests). Admins get every project. Everyone else gets
 * only the projects where their email is listed in Access Control -> New Entry Permission.
 * asEmail: optional admin-only "Test As" override, same pattern as imsApprovalGetCurrentUserInfo.
 */
function imsApprovalGetRequestableProjects(asEmail) {
  var realUser = (Session.getActiveUser().getEmail() || '').toLowerCase();
  var realIsAdmin = IMSAPPROVAL_ADMIN_EMAILS.indexOf(realUser) !== -1;
  var currentUser = (asEmail && realIsAdmin) ? asEmail.toString().trim().toLowerCase() : realUser;
  var isAdmin = IMSAPPROVAL_ADMIN_EMAILS.indexOf(currentUser) !== -1;
  if (isAdmin) return IMSAPPROVAL_PROJECTS.slice();

  var accessConfigMap = imsApprovalGetAccessConfig_();
  var peopleMap = imsApprovalGetPeopleEmailMap_();
  return IMSAPPROVAL_PROJECTS.filter(function (project) {
    var emails = imsApprovalGetAccessEmails_(IMSAPPROVAL_ACCESS_TYPES.newEntry, project, 'ALL', accessConfigMap, peopleMap);
    return emails.indexOf(currentUser) !== -1;
  });
}

function imsApprovalGetMaterialTypesForClient() {
  return IMSAPPROVAL_MATERIAL_TYPES;
}

function imsApprovalGetCurrentUserEmail() {
  return Session.getActiveUser().getEmail() || '';
}

/**
 * Client-callable: identity info for the UI, with an optional admin-only "Test As" preview.
 * asEmail, if passed, is used as the EFFECTIVE identity — for view-permission checks (what
 * shows as Restricted, whose stages are actionable) AND for actually acting via
 * imsApprovalActOnStage / imsApprovalCancelRequest, which accept the same asEmail — but ONLY
 * when the REAL logged-in user (Session.getActiveUser()) is already an admin. A non-admin
 * passing asEmail is silently ignored server-side, falling back to their own real identity;
 * this is not a way to see or act as anyone else without being an admin first. Actions taken
 * this way are real writes, recorded (Approved By, Cancelled By, etc.) under the tested email —
 * that's the point: it lets an admin verify the exact same permission checks a real user would
 * hit, not just a cosmetic preview.
 */
function imsApprovalGetCurrentUserInfo(asEmail) {
  var realEmail = Session.getActiveUser().getEmail() || '';
  var realIsAdmin = IMSAPPROVAL_ADMIN_EMAILS.indexOf(realEmail.toLowerCase()) !== -1;
  var testing = !!(asEmail && realIsAdmin);
  var effectiveEmail = testing ? asEmail.toString().trim() : realEmail;
  var effectiveIsAdmin = IMSAPPROVAL_ADMIN_EMAILS.indexOf(effectiveEmail.toLowerCase()) !== -1;
  return { email: effectiveEmail, isAdmin: effectiveIsAdmin, realEmail: realEmail, realIsAdmin: realIsAdmin, testing: testing };
}

// ---------------------------------------------------------------------------
// Approval Tracker sheet: columns synced by HEADER NAME, not fixed position.
// New stages / new extra fields get appended as new columns at the sheet's
// right edge — existing columns are never moved, renamed, or overwritten.
// ---------------------------------------------------------------------------

/** The full list of headers the code currently expects, with a reference back to where each value lives. */
function imsApprovalCanonicalFields_() {
  var fields = [];
  IMSAPPROVAL_BASE_HEADERS.forEach(function (h) {
    fields.push({ header: h, ref: { type: 'base', key: h } });
  });
  IMSAPPROVAL_STAGE_DEFS.forEach(function (stage) {
    IMSAPPROVAL_STAGE_SUBCOLS.forEach(function (sub) {
      var subKey;
      if (sub === 'Approver') subKey = 'approver';
      else if (sub === 'Approved By') subKey = 'approvedBy';
      else subKey = sub.split(' ')[0].toLowerCase();
      fields.push({ header: stage.name + ' - ' + sub, ref: { type: 'stage', stageKey: stage.key, field: subKey } });
    });
    (stage.extra || []).forEach(function (ex) {
      fields.push({ header: stage.name + ' - ' + ex.label, ref: { type: 'stage', stageKey: stage.key, field: ex.key } });
    });
  });
  return fields;
}

function imsApprovalEnsureTrackerSheet_() {
  var ss = imsApprovalGetSs_();
  var sheet = ss.getSheetByName(IMSAPPROVAL_TRACKER_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(IMSAPPROVAL_TRACKER_SHEET);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/**
 * Reads the sheet's actual header row, appends any missing canonical columns at the
 * right edge (in IMSAPPROVAL_BASE_HEADERS / stage order — see note at top of file),
 * and returns a colMap { base: {...}, stages: {...}, totalCols } built from REAL
 * column positions (so old data stays valid however headers got reordered/appended).
 */
function imsApprovalGetColumnMap_(sheet) {
  var canonical = imsApprovalCanonicalFields_();
  var lastCol = sheet.getLastColumn();
  var existingHeaders = lastCol > 0 ? sheet.getRange(1, 1, 1, lastCol).getValues()[0] : [];
  var headerIndex = {};
  existingHeaders.forEach(function (h, i) { if (h) headerIndex[h] = i + 1; });

  var map = { base: {}, stages: {} };
  var appended = [];
  var nextCol = lastCol + 1;

  canonical.forEach(function (item) {
    var col = headerIndex[item.header];
    if (!col) {
      col = nextCol++;
      appended.push({ col: col, header: item.header });
    }
    if (item.ref.type === 'base') {
      map.base[item.ref.key] = col;
    } else {
      if (!map.stages[item.ref.stageKey]) map.stages[item.ref.stageKey] = {};
      map.stages[item.ref.stageKey][item.ref.field] = col;
    }
  });

  if (appended.length) {
    appended.forEach(function (a) {
      sheet.getRange(1, a.col).setValue(a.header).setFontWeight('bold')
        .setBackground('#1e3f73').setFontColor('#ffffff');
    });
    sheet.setFrozenRows(1);
  }

  map.totalCols = Math.max(lastCol, nextCol - 1);
  return map;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns { pending, done } status label strings for a stage. Approved/Not Approved is the universal default. */
function imsApprovalStatusValues_(stageKey) {
  var stageDef = null;
  for (var i = 0; i < IMSAPPROVAL_STAGE_DEFS.length; i++) {
    if (IMSAPPROVAL_STAGE_DEFS[i].key === stageKey) { stageDef = IMSAPPROVAL_STAGE_DEFS[i]; break; }
  }
  if (stageDef && stageDef.statusValues) return stageDef.statusValues;
  return { pending: 'Not Approved', done: 'Approved' };
}

function imsApprovalGetNextSrNo_(sheet, colMap) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return 1;
  var values = sheet.getRange(2, colMap.base['Sr No'], lastRow - 1, 1).getValues();
  var max = 0;
  values.forEach(function (row) {
    var v = Number(row[0]);
    if (!isNaN(v) && v > max) max = v;
  });
  return max + 1;
}

function imsApprovalAddDays_(date, days) {
  var d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function imsApprovalStartOfDay_(date) {
  var d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function imsApprovalDaysBetween_(a, b) {
  var msPerDay = 24 * 60 * 60 * 1000;
  return Math.round((imsApprovalStartOfDay_(b) - imsApprovalStartOfDay_(a)) / msPerDay);
}

/** Given current stage key + whether advance payment is required, returns the next applicable stage key (or null if current is last). */
function imsApprovalGetNextStageKey_(currentKey, advancePaymentRequired) {
  var idx = -1;
  for (var i = 0; i < IMSAPPROVAL_STAGE_DEFS.length; i++) {
    if (IMSAPPROVAL_STAGE_DEFS[i].key === currentKey) { idx = i; break; }
  }
  if (idx === -1 || idx === IMSAPPROVAL_STAGE_DEFS.length - 1) return null;

  if (currentKey === 'rateApproval') {
    return (advancePaymentRequired === 'Yes') ? 'advancePayment' : 'delivery';
  }
  return IMSAPPROVAL_STAGE_DEFS[idx + 1].key;
}

function imsApprovalGetPrevStageKey_(currentKey, advancePaymentRequired) {
  if (currentKey === 'advancePayment') return 'rateApproval';
  if (currentKey === 'delivery') {
    return (advancePaymentRequired === 'Yes') ? 'advancePayment' : 'rateApproval';
  }
  var idx = -1;
  for (var i = 0; i < IMSAPPROVAL_STAGE_DEFS.length; i++) {
    if (IMSAPPROVAL_STAGE_DEFS[i].key === currentKey) { idx = i; break; }
  }
  if (idx <= 0) return null;
  var prevIdx = idx - 1;
  if (IMSAPPROVAL_STAGE_DEFS[prevIdx].key === 'advancePayment') return 'rateApproval';
  return IMSAPPROVAL_STAGE_DEFS[prevIdx].key;
}

/**
 * Sets every stage's Status/Approver, and computes every planned date upfront from
 * baseTimestamp (Approval Stage = baseTimestamp+1, each next = previous planned+1,
 * Delivery = PO making's planned+15, Advance Payment left blank until PO making
 * resolves it). Used both at request creation (if Entry Status = Done immediately)
 * and later when someone clicks "Start Approval Flow" on a draft entry.
 */
function imsApprovalInitializeStages_(row, colMap, project, materialType, baseTimestamp) {
  var stageConfigMap = imsApprovalGetStageConfig_();
  IMSAPPROVAL_STAGE_DEFS.forEach(function (stage) {
    var cols = colMap.stages[stage.key];
    row[cols.status - 1] = imsApprovalStatusValues_(stage.key).pending;
    if (!stage.computedApprover) {
      row[cols.approver - 1] = imsApprovalGetApproverName_(stage.key, project, materialType, '', stageConfigMap);
    }
  });

  var approvalPlanned = imsApprovalAddDays_(baseTimestamp, 1);
  row[colMap.stages['approval'].planned - 1] = approvalPlanned;
  var prevPlanned = approvalPlanned;
  var poPrepPlanned = null; // PO Preparation Stage (key 'poEntry') — Delivery's planned date is this + 15 days

  for (var i = 1; i < IMSAPPROVAL_STAGE_DEFS.length; i++) {
    var stage = IMSAPPROVAL_STAGE_DEFS[i];
    var cols = colMap.stages[stage.key];
    if (stage.key === 'advancePayment') continue; // set later, only if actually required
    var planned;
    if (stage.key === 'delivery') {
      planned = imsApprovalAddDays_(poPrepPlanned, 15);
    } else {
      planned = imsApprovalAddDays_(prevPlanned, 1);
    }
    row[cols.planned - 1] = planned;
    if (stage.key === 'poEntry') poPrepPlanned = planned;
    prevPlanned = planned;
  }
}

function imsApprovalGetApproverName_(stageKey, project, materialType, poAmount, stageConfigMap) {
  var stageDef = null;
  for (var i = 0; i < IMSAPPROVAL_STAGE_DEFS.length; i++) {
    if (IMSAPPROVAL_STAGE_DEFS[i].key === stageKey) { stageDef = IMSAPPROVAL_STAGE_DEFS[i]; break; }
  }
  if (!stageDef) return '';

  if (stageDef.computedApprover) {
    if (poAmount === '' || poAmount === null || poAmount === undefined) return '';
    var amt = Number(poAmount);
    if (isNaN(amt)) return '';
    var mt = (materialType || '').toString().trim().toUpperCase();
    for (var r = 0; r < IMSAPPROVAL_RATE_APPROVAL_RULES.length; r++) {
      var rule = IMSAPPROVAL_RATE_APPROVAL_RULES[r];
      if (rule.materialType === mt && amt <= rule.maxAmount) return rule.approver;
    }
    return '';
  }

  var configMap = stageConfigMap || imsApprovalReadStageConfigOnly_();
  var cfg = configMap[stageKey];
  if (!cfg) return '';
  return cfg.byProject[project] || '';
}

/** Returns { nameLower: email } */
function imsApprovalGetPeopleEmailMap_() {
  var sheet = imsApprovalEnsurePeopleSheet_();
  var lastRow = sheet.getLastRow();
  var map = {};
  if (lastRow < 2) return map;
  var values = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
  values.forEach(function (row) {
    var name = (row[0] || '').toString().trim();
    var email = (row[1] || '').toString().trim().toLowerCase();
    if (name) map[name.toLowerCase()] = email;
  });
  return map;
}

/**
 * Same shape as imsApprovalGetPeopleEmailMap_(), but reads the People sheet as-is without
 * calling imsApprovalEnsurePeopleSheet_() first — no sync, no writes, just a read. Use this
 * (or pass a pre-fetched map into imsApprovalResolveEmail_) anywhere the lookup happens in a
 * loop, since the syncing version is expensive and only needs to run once per page action.
 */
function imsApprovalReadPeopleEmailMapOnly_() {
  var ss = imsApprovalGetSs_();
  var sheet = ss.getSheetByName(IMSAPPROVAL_PEOPLE_SHEET);
  var map = {};
  if (!sheet) return map;
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return map;
  var values = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
  values.forEach(function (row) {
    var name = (row[0] || '').toString().trim();
    var email = (row[1] || '').toString().trim().toLowerCase();
    if (name) map[name.toLowerCase()] = email;
  });
  return map;
}

function imsApprovalResolveEmail_(name, peopleMap) {
  if (!name) return '';
  var raw = name.toString().trim();
  if (imsApprovalLooksLikeEmail_(raw)) return raw.toLowerCase();
  var map = peopleMap || imsApprovalReadPeopleEmailMapOnly_();
  return map[raw.toLowerCase()] || '';
}

function imsApprovalLooksLikeEmail_(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((value || '').toString().trim());
}

/** Splits a comma-separated list into trimmed, non-empty user names or emails. */
function imsApprovalParseNameList_(value) {
  return (value || '').toString().split(',').map(function (n) { return n.trim(); }).filter(function (n) { return !!n; });
}

/** Resolves comma-separated names/emails to lowercase emails. Pass a pre-fetched peopleMap to avoid re-reading it in a loop. */
function imsApprovalResolveEmails_(value, peopleMap) {
  var map = peopleMap || imsApprovalReadPeopleEmailMapOnly_();
  return imsApprovalParseNameList_(value)
    .map(function (n) {
      if (imsApprovalLooksLikeEmail_(n)) return n.toLowerCase();
      return map[n.toLowerCase()] || '';
    })
    .filter(function (e) { return !!e; });
}

// ---------------------------------------------------------------------------
// People sheet: Approver Name -> Email lookup
// Synced additively: missing names get appended, existing rows (and emails) untouched.
// ---------------------------------------------------------------------------

function imsApprovalEnsurePeopleSheet_() {
  var ss = imsApprovalGetSs_();
  var sheet = ss.getSheetByName(IMSAPPROVAL_PEOPLE_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(IMSAPPROVAL_PEOPLE_SHEET);
    sheet.appendRow(['Name', 'Email']);
    sheet.getRange(1, 1, 1, 2).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  imsApprovalSyncPeopleSheet_(sheet);
  return sheet;
}

function imsApprovalAddReferencedPeople_(allNames, value) {
  imsApprovalParseNameList_(value).forEach(function (name) {
    if (!name || name.indexOf('(computed') === 0 || imsApprovalLooksLikeEmail_(name)) return;
    allNames[name] = true;
  });
}

/** Additive sync: adds any name referenced anywhere (stage grid, access rows, rate rules) that isn't already listed. */
function imsApprovalSyncPeopleSheet_(sheet) {
  var lastRow = sheet.getLastRow();
  var existingNames = {};
  if (lastRow >= 2) {
    var names = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    names.forEach(function (row) { if (row[0]) existingNames[row[0].toString().trim().toLowerCase()] = true; });
  }

  var allNames = {};
  Object.keys(IMSAPPROVAL_SEED_APPROVERS).forEach(function (stageKey) {
    var byProject = IMSAPPROVAL_SEED_APPROVERS[stageKey];
    Object.keys(byProject).forEach(function (proj) { imsApprovalAddReferencedPeople_(allNames, byProject[proj]); });
  });
  IMSAPPROVAL_RATE_APPROVAL_RULES.forEach(function (rule) { imsApprovalAddReferencedPeople_(allNames, rule.approver); });

  // Also pick up any names actually typed into the live Stage Config grid (covers manual reassignments)
  var configSheet = imsApprovalGetSs_().getSheetByName(IMSAPPROVAL_CONFIG_SHEET);
  if (configSheet) {
    var lastR = configSheet.getLastRow();
    var lastC = configSheet.getLastColumn();
    if (lastR >= 2 && lastC >= 4) {
      var grid = configSheet.getRange(2, 4, lastR - 1, lastC - 3).getValues();
      grid.forEach(function (row) {
        row.forEach(function (name) {
          imsApprovalAddReferencedPeople_(allNames, name);
        });
      });
    }
  }

  // Also pick up names typed into Access Control. Direct emails there work as-is and
  // do not need rows in People.
  var accessSheet = imsApprovalGetSs_().getSheetByName(IMSAPPROVAL_ACCESS_SHEET);
  if (accessSheet) {
    var accessLastRow = accessSheet.getLastRow();
    if (accessLastRow >= 2) {
      var accessNames = accessSheet.getRange(2, 5, accessLastRow - 1, 1).getValues();
      accessNames.forEach(function (row) { imsApprovalAddReferencedPeople_(allNames, row[0]); });
    }
  }

  var toAdd = Object.keys(allNames).filter(function (name) {
    return !existingNames[name.toLowerCase()];
  }).sort();

  toAdd.forEach(function (name) { sheet.appendRow([name, '']); });
  sheet.autoResizeColumns(1, 2);
}

// ---------------------------------------------------------------------------
// Client-callable: submit new request
// ---------------------------------------------------------------------------

/**
 * payload: { project, constructionType, block, lot, materialName, materialType,
 *            quantity, estimatedDeliveryDate, remarks, entryStatus }
 * On success, if the Project + Construction Type + Block + LOT + Material Name combo
 * matches a row in "Material Quantity Master", that row's Remaining is reduced by
 * quantity immediately (per your instruction: deduct as soon as the request is
 * submitted, not at a later stage). If no matching row is found, the request is
 * still saved — qtySynced comes back false so the UI can note that.
 * payload.planned: 'Planned' or 'Non Planned' (defaults to 'Non Planned' if omitted/unrecognized).
 * Planned requires Construction Type/Block/LOT and, on success, deducts the submitted
 * Quantity from the matching row in "Material Quantity Master" (if the combo is found
 * there) — same as before. Non Planned skips both: Construction Type/Block/LOT are
 * optional free text with no bearing on anything, and Material Quantity Master is never
 * touched — Quantity is just whatever the person typed, no sync, no deduction.
 */
function imsApprovalSubmitRequest(payload) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var isPlanned = payload && payload.planned === 'Planned';

    if (!payload || !payload.project || !payload.materialName || !payload.materialType) {
      throw new Error('Project, Material Name, and Material Type are required.');
    }
    if (isPlanned && (!payload.constructionType || !payload.block || !payload.lot)) {
      throw new Error('Construction Type, Block, and LOT are required for a Planned entry.');
    }
    var quantity = Number(payload.quantity);
    if (!payload.quantity || isNaN(quantity) || quantity <= 0) {
      throw new Error('Quantity must be a number greater than 0.');
    }
    var uom = (payload.uom || '').toString().trim();
    if (!uom) {
      throw new Error('UOM is required.');
    }
    var entryStatus = (payload.entryStatus === 'Done') ? 'Done' : 'Not Done';

    var userEmail = (Session.getActiveUser().getEmail() || 'unknown');
    var userEmailLower = userEmail.toLowerCase();
    var isSubmitterAdmin = IMSAPPROVAL_ADMIN_EMAILS.indexOf(userEmailLower) !== -1;
    if (!isSubmitterAdmin) {
      var requestPermEmails = imsApprovalGetAccessEmails_(IMSAPPROVAL_ACCESS_TYPES.newEntry, payload.project, 'ALL');
      if (requestPermEmails.indexOf(userEmailLower) === -1) {
        throw new Error('You do not have permission to raise a purchase request for "' + payload.project +
          '". Ask an admin to add you to Access Control \u2192 New Entry Permission for that project.');
      }
    }

    var sheet = imsApprovalEnsureTrackerSheet_();
    var colMap = imsApprovalGetColumnMap_(sheet);
    var srNo = imsApprovalGetNextSrNo_(sheet, colMap);
    var now = new Date();

    var row = new Array(colMap.totalCols).fill('');
    row[colMap.base['Sr No'] - 1] = srNo;
    row[colMap.base['Project'] - 1] = payload.project;
    row[colMap.base['Planned'] - 1] = isPlanned ? 'Planned' : 'Non Planned';
    row[colMap.base['Construction Type'] - 1] = payload.constructionType || '';
    row[colMap.base['Block'] - 1] = payload.block || '';
    row[colMap.base['LOT'] - 1] = payload.lot || '';
    row[colMap.base['Material Name'] - 1] = payload.materialName;
    row[colMap.base['Material Type'] - 1] = payload.materialType;
    row[colMap.base['UOM'] - 1] = uom;
    row[colMap.base['Quantity'] - 1] = quantity;
    row[colMap.base['Estimated Delivery Date'] - 1] = payload.estimatedDeliveryDate || '';
    row[colMap.base['Status'] - 1] = 'Not Done';
    row[colMap.base['Entry Status'] - 1] = entryStatus;
    row[colMap.base['UserEmail'] - 1] = userEmail;
    row[colMap.base['Remarks'] - 1] = payload.remarks || '';
    row[colMap.base['Entry Timestamp'] - 1] = now;

    if (entryStatus === 'Done') {
      imsApprovalInitializeStages_(row, colMap, payload.project, payload.materialType, now);
    }
    // If Not Done: every stage cell stays blank — nothing is actionable, nothing shows
    // in anyone's Approval Flow queue, until someone starts the flow (see imsApprovalStartFlow).

    sheet.getRange(sheet.getLastRow() + 1, 1, 1, row.length).setValues([row]);

    var qtySync = { synced: false };
    if (isPlanned) {
      qtySync = imsApprovalDeductQtyMaster_(payload.project, payload.constructionType, payload.block, payload.lot, payload.materialName, quantity);
    }

    return { success: true, srNo: srNo, qtySynced: qtySync.synced, remainingAfter: qtySync.synced ? qtySync.remaining : null };
  } catch (err) {
    return { success: false, error: err.message };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Client-callable: turns a draft (Entry Status = Not Done) request into an active one.
 * Computes every planned date fresh from right now, then flips Entry Status to Done.
 * (Quantity Master deduction already happened at submission time, so this doesn't touch it again.)
 */
function imsApprovalStartFlow(srNo) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = imsApprovalEnsureTrackerSheet_();
    var colMap = imsApprovalGetColumnMap_(sheet);
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) throw new Error('No requests found.');

    var srNoValues = sheet.getRange(2, colMap.base['Sr No'], lastRow - 1, 1).getValues();
    var targetRow = -1;
    for (var r = 0; r < srNoValues.length; r++) {
      if (Number(srNoValues[r][0]) === Number(srNo)) { targetRow = r + 2; break; }
    }
    if (targetRow === -1) throw new Error('Request Sr No ' + srNo + ' not found.');

    var rowValues = sheet.getRange(targetRow, 1, 1, colMap.totalCols).getValues()[0];
    if ((rowValues[colMap.base['Cancelled'] - 1] || '') === 'Yes') {
      throw new Error('This request has been cancelled.');
    }
    if (rowValues[colMap.base['Entry Status'] - 1] === 'Done') {
      throw new Error('This request\u2019s approval flow has already started.');
    }

    var project = rowValues[colMap.base['Project'] - 1];
    var materialType = rowValues[colMap.base['Material Type'] - 1];
    var now = new Date();

    var row = rowValues.slice();
    imsApprovalInitializeStages_(row, colMap, project, materialType, now);
    row[colMap.base['Entry Status'] - 1] = 'Done';

    sheet.getRange(targetRow, 1, 1, row.length).setValues([row]);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Client-callable: list all requests, fully parsed
// ---------------------------------------------------------------------------

/**
 * asEmail: optional admin-only "Test As" preview (see imsApprovalGetCurrentUserInfo) — only
 * takes effect when the REAL caller is already an admin; otherwise ignored and the real
 * identity is used, same as always.
 */
function imsApprovalGetRequests(asEmail) {
  var sheet = imsApprovalEnsureTrackerSheet_();
  var colMap = imsApprovalGetColumnMap_(sheet);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  var realUser = (Session.getActiveUser().getEmail() || '').toLowerCase();
  var realIsAdmin = IMSAPPROVAL_ADMIN_EMAILS.indexOf(realUser) !== -1;
  var currentUser = (asEmail && realIsAdmin) ? asEmail.toString().trim().toLowerCase() : realUser;
  var isAdmin = IMSAPPROVAL_ADMIN_EMAILS.indexOf(currentUser) !== -1;
  var values = sheet.getRange(2, 1, lastRow - 1, colMap.totalCols).getValues();

  // Fetched ONCE per call (not once per stage per row) — this used to be the main slowdown:
  // every approver/email lookup below was re-reading (and re-syncing) these sheets from scratch.
  var peopleMap = imsApprovalGetPeopleEmailMap_();
  var stageConfigMap = imsApprovalGetStageConfig_();
  var accessConfigMap = imsApprovalGetAccessConfig_();

  var requests = values.map(function (row, idx) {
    var project = row[colMap.base['Project'] - 1];
    var materialType = row[colMap.base['Material Type'] - 1];

    var req = {
      rowIndex: idx + 2,
      srNo: row[colMap.base['Sr No'] - 1],
      project: project,
      planned: row[colMap.base['Planned'] - 1] || 'Non Planned',
      constructionType: row[colMap.base['Construction Type'] - 1],
      block: row[colMap.base['Block'] - 1],
      lot: row[colMap.base['LOT'] - 1],
      materialName: row[colMap.base['Material Name'] - 1],
      materialType: materialType,
      uom: row[colMap.base['UOM'] - 1] || '',
      quantity: row[colMap.base['Quantity'] - 1],
      estimatedDeliveryDate: imsApprovalFormatDate_(row[colMap.base['Estimated Delivery Date'] - 1]),
      overallStatus: row[colMap.base['Status'] - 1] || 'Not Done',
      entryStatus: row[colMap.base['Entry Status'] - 1] || 'Not Done',
      cancelled: (row[colMap.base['Cancelled'] - 1] || '') === 'Yes',
      cancelledBy: row[colMap.base['Cancelled By'] - 1] || '',
      cancelledAt: imsApprovalFormatDT_(row[colMap.base['Cancelled At'] - 1]),
      cancelReason: row[colMap.base['Cancel Reason'] - 1] || '',
      userEmail: row[colMap.base['UserEmail'] - 1],
      remarks: row[colMap.base['Remarks'] - 1],
      entryTimestamp: imsApprovalFormatDT_(row[colMap.base['Entry Timestamp'] - 1]),
      stages: {}
    };

    // Who can cancel THIS request: the original requester, an admin, or whoever is granted
    // Access Control -> Cancel Permission for this project. Uses the same currentUser/isAdmin
    // as everything else in this function, so "Test As" is gated consistently.
    var cancelPermEmails = imsApprovalGetAccessEmails_(IMSAPPROVAL_ACCESS_TYPES.cancel, project, 'ALL', accessConfigMap, peopleMap);
    var requesterEmailForCancel = (req.userEmail || '').toString().toLowerCase();
    req.canCancel = !req.cancelled && (isAdmin || currentUser === requesterEmailForCancel || cancelPermEmails.indexOf(currentUser) !== -1);

    var poAmount = row[colMap.stages['poEntry'].poAmount - 1];
    var entryStatusVal = row[colMap.base['Entry Status'] - 1] || 'Not Done';
    var advReqForGating = row[colMap.stages['poEntry'].advancePaymentRequired - 1] || '';

    IMSAPPROVAL_STAGE_DEFS.forEach(function (stage) {
      var cols = colMap.stages[stage.key];
      var approverName = row[cols.approver - 1] || '';
      if (!approverName && entryStatusVal === 'Done') {
        approverName = imsApprovalGetApproverName_(stage.key, project, materialType, poAmount, stageConfigMap);
      }
      var approverEmail = imsApprovalResolveEmail_(approverName, peopleMap);
      var status = row[cols.status - 1] || imsApprovalStatusValues_(stage.key).pending;
      var doneLabel = imsApprovalStatusValues_(stage.key).done;
      var isBackupApprover = imsApprovalGetAccessEmails_(IMSAPPROVAL_ACCESS_TYPES.backup, project, stage.key, accessConfigMap, peopleMap).indexOf(currentUser) !== -1;

      var prevKey = imsApprovalGetPrevStageKey_(stage.key, advReqForGating);
      var prevStageDone = true;
      if (prevKey) {
        var prevStageData = req.stages[prevKey];
        prevStageDone = !!prevStageData && prevStageData.status === imsApprovalStatusValues_(prevKey).done;
      }

      var stageData = {
        approver: approverName,
        planned: imsApprovalFormatDT_(row[cols.planned - 1]),
        actual: imsApprovalFormatDT_(row[cols.actual - 1]),
        delay: row[cols.delay - 1] === '' ? '' : row[cols.delay - 1],
        status: status,
        approvedBy: row[cols.approvedBy - 1] || '',
        canCurrentUserAct: entryStatusVal === 'Done' && status !== doneLabel && prevStageDone && (isAdmin || (!!approverEmail && approverEmail === currentUser) || isBackupApprover),
        isMyStage: isAdmin || (!!approverEmail && approverEmail === currentUser) || isBackupApprover
      };
      (stage.extra || []).forEach(function (ex) {
        stageData[ex.key] = row[cols[ex.key] - 1] || '';
      });
      req.stages[stage.key] = stageData;
    });

    return req;
  });

  requests.reverse();
  return requests;
}

/**
 * Flat list of action items. For a normal user: stages where THEY are the resolved
 * approver and it's currently actionable. For an admin (IMSAPPROVAL_ADMIN_EMAILS):
 * EVERY currently-pending, currently-actionable stage across ALL requests, with the
 * assigned approver's name shown — so they see the whole flow, not just their own items.
 *
 * Each item now also carries the material/request details (construction type, block, LOT,
 * quantity, remarks, requester, plus any values captured at earlier stages such as Indent No,
 * Vendor Name, PO Amount, PO No, Challan No.) so the Approval Flow UI can show what is
 * actually being approved without opening the Purchase Request page.
 */
/**
 * For ONE specific stage of ONE request: walks the ENTIRE predecessor chain behind it
 * (using imsApprovalGetPrevStageKey_ — the same chain real gating uses, so this always
 * agrees with canCurrentUserAct/prevStageDone, including the Advance Payment/Delivery
 * branch) all the way back to the first stage, and returns { key, name, approver } for
 * the EARLIEST (first/oldest) stage in that chain that still isn't Done. That is the
 * true root cause holding up the whole request — not just the one stage directly before
 * this one. Returns null if stageKey itself is already Done, or if every stage before it
 * is already Done (meaning this stage is not blocked by sequence — it's actionable now,
 * or blocked for some other reason such as approver identity).
 */
function imsApprovalGetBlockingPredecessor_(req, stageKey) {
  var sd = req.stages[stageKey];
  if (!sd) return null;
  var doneLabel = imsApprovalStatusValues_(stageKey).done;
  if (sd.status === doneLabel) return null;

  var advReqForGating = req.stages['poEntry'] && req.stages['poEntry'].advancePaymentRequired;
  var earliestUndoneKey = null;
  var key = stageKey;
  var guard = 0;
  while (guard++ < IMSAPPROVAL_STAGE_DEFS.length) {
    var prevKey = imsApprovalGetPrevStageKey_(key, advReqForGating);
    if (!prevKey) break; // reached the very first stage
    var prevSd = req.stages[prevKey];
    var prevDoneLabel = imsApprovalStatusValues_(prevKey).done;
    if (!prevSd || prevSd.status !== prevDoneLabel) {
      earliestUndoneKey = prevKey; // keep walking — an even earlier stage may also be undone
    }
    key = prevKey;
  }
  if (!earliestUndoneKey) return null;

  var prevDef = null;
  for (var i = 0; i < IMSAPPROVAL_STAGE_DEFS.length; i++) {
    if (IMSAPPROVAL_STAGE_DEFS[i].key === earliestUndoneKey) { prevDef = IMSAPPROVAL_STAGE_DEFS[i]; break; }
  }
  if (!prevDef) return null;
  var prevSdFinal = req.stages[earliestUndoneKey];
  return { key: earliestUndoneKey, name: prevDef.name, approver: prevSdFinal ? prevSdFinal.approver : '' };
}

function imsApprovalGetMyQueue(asEmail) {
  var requests = imsApprovalGetRequests(asEmail);
  var realUser = (Session.getActiveUser().getEmail() || '').toLowerCase();
  var realIsAdmin = IMSAPPROVAL_ADMIN_EMAILS.indexOf(realUser) !== -1;
  var currentUser = (asEmail && realIsAdmin) ? asEmail.toString().trim().toLowerCase() : realUser;
  var isAdmin = IMSAPPROVAL_ADMIN_EMAILS.indexOf(currentUser) !== -1;
  var queue = [];

  requests.forEach(function (req) {
    if (req.cancelled) return; // cancelled requests never appear in anyone's queue
    IMSAPPROVAL_STAGE_DEFS.forEach(function (stage) {
      var sd = req.stages[stage.key];
      if (!sd) return;
      if (stage.key === 'advancePayment') {
        var advReq = req.stages['poEntry'] && req.stages['poEntry'].advancePaymentRequired;
        if (advReq !== 'Yes') return;
      }
      var blockingPredecessor = imsApprovalGetBlockingPredecessor_(req, stage.key);

      var doneLabel = imsApprovalStatusValues_(stage.key).done;
      var isPendingAndUnlocked = sd.status !== doneLabel && sd.approver; // approver known = previous stage's gating already resolved it enough to compute one
      // Admins: see every pending/unlocked stage across all requests.
      // Normal users: see every stage assigned to them (isMyStage) that isn't done yet,
      // even while it's still locked behind a previous stage — so their queue shows what's
      // coming, not just what's clickable right now. The "Mark Approved" action stays gated
      // separately via canAct (sd.canCurrentUserAct), which already requires the previous
      // stage to be done, so nothing can be approved out of order.
      var include = isAdmin ? isPendingAndUnlocked : (sd.isMyStage && sd.status !== doneLabel);
      if (!include) return;

      queue.push({
        srNo: req.srNo,
        project: req.project,
        planType: req.planned,
        materialName: req.materialName,
        materialType: req.materialType,
        constructionType: req.constructionType,
        block: req.block,
        lot: req.lot,
        uom: req.uom,
        quantity: req.quantity,
        remarks: req.remarks,
        requestedBy: req.userEmail,
        entryTimestamp: req.entryTimestamp,
        estimatedDeliveryDate: req.estimatedDeliveryDate,
        indentNo: req.stages['indent'] ? req.stages['indent'].indentNo : '',
        vendorName: req.stages['poEntry'] ? req.stages['poEntry'].vendorName : '',
        poAmount: req.stages['poEntry'] ? req.stages['poEntry'].poAmount : '',
        poNo: req.stages['poEntry'] ? req.stages['poEntry'].poNo : '',
        paymentTerms: req.stages['poEntry'] ? req.stages['poEntry'].paymentTerms : '',
        challanBillNo: req.stages['delivery'] ? req.stages['delivery'].challanBillNo : '',
        stageKey: stage.key,
        stageName: stage.name,
        blockedByStageKey: blockingPredecessor ? blockingPredecessor.key : '',
        blockedByStageName: blockingPredecessor ? blockingPredecessor.name : '',
        blockedByApprover: blockingPredecessor ? blockingPredecessor.approver : '',
        planned: sd.planned,
        status: sd.status,
        approver: sd.approver,
        canAct: sd.canCurrentUserAct
      });
    });
  });

  queue.sort(function (a, b) {
    if (!a.planned) return 1;
    if (!b.planned) return -1;
    return new Date(a.planned) - new Date(b.planned);
  });

  return queue;
}

/**
 * Client-callable: the stage keys the current (or Test-As'd) user is ASSIGNED to, so the
 * Approval Flow page can show only their own stage tiles — even when nothing is pending yet.
 * A stage counts as theirs when their email matches the approver for that stage on ANY project
 * in Stage Config, they match a Rate Approval rule approver (computed stage), or they are a
 * Backup Approver for it in Access Control. Admins get every stage (same as before).
 */
function imsApprovalGetMyStageKeys(asEmail) {
  var realUser = (Session.getActiveUser().getEmail() || '').toLowerCase();
  var realIsAdmin = IMSAPPROVAL_ADMIN_EMAILS.indexOf(realUser) !== -1;
  var currentUser = (asEmail && realIsAdmin) ? asEmail.toString().trim().toLowerCase() : realUser;
  var isAdmin = IMSAPPROVAL_ADMIN_EMAILS.indexOf(currentUser) !== -1;

  if (isAdmin) {
    return IMSAPPROVAL_STAGE_DEFS.map(function (s) { return s.key; });
  }

  var peopleMap = imsApprovalGetPeopleEmailMap_();
  var stageConfigMap = imsApprovalGetStageConfig_();
  var accessConfigMap = imsApprovalGetAccessConfig_();
  var keys = [];

  IMSAPPROVAL_STAGE_DEFS.forEach(function (stage) {
    var assigned = false;

    if (stage.computedApprover) {
      IMSAPPROVAL_RATE_APPROVAL_RULES.forEach(function (rule) {
        if (imsApprovalResolveEmail_(rule.approver, peopleMap) === currentUser) assigned = true;
      });
    } else {
      var cfg = stageConfigMap[stage.key];
      if (cfg) {
        Object.keys(cfg.byProject).forEach(function (proj) {
          var emails = imsApprovalResolveEmails_(cfg.byProject[proj], peopleMap);
          if (emails.indexOf(currentUser) !== -1) assigned = true;
        });
      }
    }

    if (!assigned) {
      IMSAPPROVAL_PROJECTS.forEach(function (proj) {
        var backups = imsApprovalGetAccessEmails_(IMSAPPROVAL_ACCESS_TYPES.backup, proj, stage.key, accessConfigMap, peopleMap);
        if (backups.indexOf(currentUser) !== -1) assigned = true;
      });
    }

    if (assigned) keys.push(stage.key);
  });

  return keys;
}

function imsApprovalFormatDate_(value) {
  if (!value) return '';
  if (Object.prototype.toString.call(value) === '[object Date]') {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), 'dd-MMM-yyyy');
  }
  return value;
}

function imsApprovalFormatDT_(value) {
  if (!value) return '';
  if (Object.prototype.toString.call(value) === '[object Date]') {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), 'dd-MMM-yyyy hh:mm a');
  }
  return value;
}

// ---------------------------------------------------------------------------
// Client-callable: mark a stage Done
// ---------------------------------------------------------------------------

/**
 * payload: { srNo, stageKey, extraFields: {...} }
 */
function imsApprovalActOnStage(payload) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    if (!payload || !payload.srNo || !payload.stageKey) {
      throw new Error('Missing srNo or stageKey.');
    }
    var stageDef = null;
    for (var i = 0; i < IMSAPPROVAL_STAGE_DEFS.length; i++) {
      if (IMSAPPROVAL_STAGE_DEFS[i].key === payload.stageKey) { stageDef = IMSAPPROVAL_STAGE_DEFS[i]; break; }
    }
    if (!stageDef) throw new Error('Unknown stage: ' + payload.stageKey);

    var sheet = imsApprovalEnsureTrackerSheet_();
    var colMap = imsApprovalGetColumnMap_(sheet);
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) throw new Error('No requests found.');

    var srNoCol = colMap.base['Sr No'];
    var srNoValues = sheet.getRange(2, srNoCol, lastRow - 1, 1).getValues();
    var targetRow = -1;
    for (var r = 0; r < srNoValues.length; r++) {
      if (Number(srNoValues[r][0]) === Number(payload.srNo)) { targetRow = r + 2; break; }
    }
    if (targetRow === -1) throw new Error('Request Sr No ' + payload.srNo + ' not found.');

    var rowValues = sheet.getRange(targetRow, 1, 1, colMap.totalCols).getValues()[0];
    if ((rowValues[colMap.base['Cancelled'] - 1] || '') === 'Yes') {
      throw new Error('This request has been cancelled.');
    }
    if ((rowValues[colMap.base['Entry Status'] - 1] || 'Not Done') !== 'Done') {
      throw new Error('This request is still a draft — start its approval flow first.');
    }
    var project = rowValues[colMap.base['Project'] - 1];
    var materialType = rowValues[colMap.base['Material Type'] - 1];
    var poAmountExisting = rowValues[colMap.stages['poEntry'].poAmount - 1];

    var poAmountForApprover = (payload.stageKey === 'poEntry' && payload.extraFields && payload.extraFields.poAmount)
      ? payload.extraFields.poAmount : poAmountExisting;
    var approverName = imsApprovalGetApproverName_(payload.stageKey, project, materialType, poAmountForApprover);
    var realUser = (Session.getActiveUser().getEmail() || '').toLowerCase();
    var realIsAdmin = IMSAPPROVAL_ADMIN_EMAILS.indexOf(realUser) !== -1;
    // "Test As" (admin-only): lets a real admin act on a stage AS a specific email, to verify
    // that only the correctly-assigned approver can actually approve it. Only takes effect when
    // the REAL caller is already an admin — otherwise ignored, same identity as always.
    var currentUser = (payload.asEmail && realIsAdmin) ? payload.asEmail.toString().trim().toLowerCase() : realUser;
    var isAdmin = IMSAPPROVAL_ADMIN_EMAILS.indexOf(currentUser) !== -1;
    // Access Control -> Backup Approver: anyone listed for this project (or this exact
    // project/stage) can also act, while the shown "Approver" still comes from Stage Config.
    var isBackupApprover = imsApprovalGetAccessEmails_(IMSAPPROVAL_ACCESS_TYPES.backup, project, payload.stageKey).indexOf(currentUser) !== -1;
    if (!approverName && !isAdmin && !isBackupApprover) {
      throw new Error('No approver configured for "' + stageDef.name + '" for this request yet.');
    }
    var approverEmail = approverName ? imsApprovalResolveEmail_(approverName) : '';
    if (!isAdmin && !isBackupApprover) {
      if (!approverEmail) {
        throw new Error('No email on file for "' + approverName + '" in the People sheet. Please add it there first.');
      }
      if (currentUser !== approverEmail) {
        throw new Error('You are not the assigned approver for "' + stageDef.name + '" (assigned: ' + approverName + ').');
      }
    }

    var advReq = rowValues[colMap.stages['poEntry'].advancePaymentRequired - 1] || '';
    var prevKey = imsApprovalGetPrevStageKey_(payload.stageKey, advReq);
    if (prevKey) {
      var prevStatus = rowValues[colMap.stages[prevKey].status - 1];
      var prevDoneLabel = imsApprovalStatusValues_(prevKey).done;
      if (prevStatus !== prevDoneLabel) {
        throw new Error('Previous stage is not yet ' + prevDoneLabel + '. Complete it first.');
      }
    }

    var thisCols = colMap.stages[payload.stageKey];
    var thisStatusValues = imsApprovalStatusValues_(payload.stageKey);
    var already = rowValues[thisCols.status - 1];
    if (already === thisStatusValues.done) {
      throw new Error('This stage is already marked ' + thisStatusValues.done + '.');
    }

    if (payload.stageKey === 'poEntry') {
      var advVal = payload.extraFields && payload.extraFields.advancePaymentRequired;
      if (advVal !== 'Yes' && advVal !== 'No') {
        throw new Error('Advance Payment Required must be explicitly set to Yes or No.');
      }
    }

    var now = new Date();
    var plannedVal = rowValues[thisCols.planned - 1];

    // Apply every change to an in-memory copy of the row, then write it ALL in one call at
    // the end. The old code did up to 9 separate sheet.getRange(...).setValue() round trips
    // here (plus an extra read) while holding the script lock — on a live sheet with other
    // people also trying to act, that's exactly what causes "Lock timeout" for everyone else
    // waiting their turn. One batched write is dramatically faster and holds the lock far less.
    var row = rowValues.slice();
    row[thisCols.actual - 1] = now;
    row[thisCols.status - 1] = thisStatusValues.done;
    row[thisCols.approvedBy - 1] = currentUser;
    row[thisCols.approver - 1] = approverName;
    if (plannedVal) {
      var delay = imsApprovalDaysBetween_(now, new Date(plannedVal));
      row[thisCols.delay - 1] = delay;
    }

    // Every extra field is required on every stage EXCEPT PO Rate Stage (its only field,
    // Remarks, stays optional there) — enforced here too, not just client-side.
    if (stageDef.extra && payload.stageKey !== 'poRate') {
      stageDef.extra.forEach(function (ex) {
        var val = payload.extraFields ? payload.extraFields[ex.key] : undefined;
        if (val === undefined || val === null || val.toString().trim() === '') {
          throw new Error(ex.label + ' is required.');
        }
      });
    }

    if (payload.extraFields && stageDef.extra) {
      stageDef.extra.forEach(function (ex) {
        if (payload.extraFields[ex.key] !== undefined) {
          row[thisCols[ex.key] - 1] = payload.extraFields[ex.key];
        }
      });
    }

    if (payload.stageKey === 'poEntry') {
      var poAmountNow = (payload.extraFields && payload.extraFields.poAmount !== undefined)
        ? payload.extraFields.poAmount : poAmountExisting;
      var rateApprovalName = imsApprovalGetApproverName_('rateApproval', project, materialType, poAmountNow);
      if (rateApprovalName) {
        row[colMap.stages['rateApproval'].approver - 1] = rateApprovalName;
      }
    }

    // Advance Payment Stage sits right after Rate Approval Stage. Whether it's needed at all
    // was decided back at PO Preparation Stage (advancePaymentRequired, read into `advReq`
    // above) and is now fixed/persisted — so once Rate Approval Stage itself is actually
    // completed, that's the moment to set Advance Payment's planned date (its own planned + 1),
    // same pattern as before, just one stage later in the chain.
    if (payload.stageKey === 'rateApproval' && advReq === 'Yes') {
      var ratePlannedVal = plannedVal; // already read above — no second getRange().getValue() call
      var advPlanned = ratePlannedVal ? imsApprovalAddDays_(new Date(ratePlannedVal), 1) : imsApprovalAddDays_(now, 1);
      row[colMap.stages['advancePayment'].planned - 1] = advPlanned;
    }

    var nextKey = imsApprovalGetNextStageKey_(payload.stageKey, advReq);
    if (!nextKey) {
      row[colMap.base['Status'] - 1] = 'Done';
    }

    sheet.getRange(targetRow, 1, 1, row.length).setValues([row]);

    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Client-callable: mark multiple queue items approved in one action.
 * Each item still goes through imsApprovalActOnStage(), so permissions, prior-stage
 * gating, cancellation checks, and stage-specific rules remain server-enforced.
 *
 * payload: { items: [{ srNo, stageKey }], asEmail }
 */
function imsApprovalActOnStages(payload) {
  var items = (payload && payload.items) || [];
  if (!items || !items.length) {
    return { success: false, successCount: 0, failureCount: 0, results: [], error: 'No requests selected.' };
  }
  if (items.length > 50) {
    return { success: false, successCount: 0, failureCount: items.length, results: [], error: 'Select 50 or fewer requests at a time.' };
  }

  var seen = {};
  var results = [];
  items.forEach(function (item) {
    var srNo = item && item.srNo;
    var stageKey = item && item.stageKey;
    var result = { srNo: srNo, stageKey: stageKey, success: false };
    var key = stageKey + '|' + srNo;
    if (!srNo || !stageKey) {
      result.error = 'Missing request number or stage.';
      results.push(result);
      return;
    }
    if (seen[key]) return;
    seen[key] = true;

    try {
      var res = imsApprovalActOnStage({
        srNo: srNo,
        stageKey: stageKey,
        extraFields: {},
        asEmail: payload.asEmail || ''
      });
      result.success = !!(res && res.success);
      if (!result.success) result.error = (res && res.error) || 'Failed.';
    } catch (err) {
      result.error = err.message || 'Failed.';
    }
    results.push(result);
  });

  var successCount = results.filter(function (r) { return r.success; }).length;
  var failureCount = results.length - successCount;
  return {
    success: failureCount === 0,
    successCount: successCount,
    failureCount: failureCount,
    results: results
  };
}

/**
 * Same batch behaviour as imsApprovalActOnStages, but applies ONE shared
 * extraFields object (e.g. Vendor Name / PO Amount / PO No / Advance Payment
 * Required at PO Preparation Stage) to every selected item. Used when many
 * requests share the same PO No and the approver wants to fill those fields
 * once instead of per request. Each item still goes through the normal
 * per-request validation/permission/gating inside imsApprovalActOnStage.
 */
function imsApprovalActOnStagesWithSharedFields(payload) {
  var items = (payload && payload.items) || [];
  var extraFields = (payload && payload.extraFields) || {};
  if (!items || !items.length) {
    return { success: false, successCount: 0, failureCount: 0, results: [], error: 'No requests selected.' };
  }
  if (items.length > 50) {
    return { success: false, successCount: 0, failureCount: items.length, results: [], error: 'Select 50 or fewer requests at a time.' };
  }

  var seen = {};
  var results = [];
  items.forEach(function (item) {
    var srNo = item && item.srNo;
    var stageKey = item && item.stageKey;
    var result = { srNo: srNo, stageKey: stageKey, success: false };
    var key = stageKey + '|' + srNo;
    if (!srNo || !stageKey) {
      result.error = 'Missing request number or stage.';
      results.push(result);
      return;
    }
    if (seen[key]) return;
    seen[key] = true;

    try {
      var res = imsApprovalActOnStage({
        srNo: srNo,
        stageKey: stageKey,
        extraFields: extraFields,
        asEmail: payload.asEmail || ''
      });
      result.success = !!(res && res.success);
      if (!result.success) result.error = (res && res.error) || 'Failed.';
    } catch (err) {
      result.error = err.message || 'Failed.';
    }
    results.push(result);
  });

  var successCount = results.filter(function (r) { return r.success; }).length;
  var failureCount = results.length - successCount;
  return {
    success: failureCount === 0,
    successCount: successCount,
    failureCount: failureCount,
    results: results
  };
}

// ---------------------------------------------------------------------------
// Client-callable: cancel a request
// ---------------------------------------------------------------------------

/**
 * Cancels a request (draft or active, at any stage) and — if its Project +
 * Construction Type + Block + LOT + Material Name combo matches a row in
 * "Material Quantity Master" — adds its Quantity back onto that row's Remaining,
 * undoing the deduction made at submission time.
 *
 * Who can cancel: the original requester, an admin (IMSAPPROVAL_ADMIN_EMAILS), or
 * whoever is granted Access Control -> Cancel Permission for that request's
 * project (resolved through People, direct emails, or a mix of both).
 * A request can only be cancelled once (cancelling twice does not double-restore
 * the quantity).
 *
 * payload: { srNo, reason, cancelDate } — reason is required; cancelDate is the
 * date the cancelling user enters (YYYY-MM-DD, e.g. from an <input type="date">),
 * defaulting to right now if omitted or unparseable.
 */
function imsApprovalCancelRequest(payload) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    if (!payload || !payload.srNo) throw new Error('Missing srNo.');
    var reason = (payload.reason || '').toString().trim();
    if (!reason) throw new Error('Cancel Reason is required.');

    var sheet = imsApprovalEnsureTrackerSheet_();
    var colMap = imsApprovalGetColumnMap_(sheet);
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) throw new Error('No requests found.');

    var srNoValues = sheet.getRange(2, colMap.base['Sr No'], lastRow - 1, 1).getValues();
    var targetRow = -1;
    for (var r = 0; r < srNoValues.length; r++) {
      if (Number(srNoValues[r][0]) === Number(payload.srNo)) { targetRow = r + 2; break; }
    }
    if (targetRow === -1) throw new Error('Request Sr No ' + payload.srNo + ' not found.');

    var rowValues = sheet.getRange(targetRow, 1, 1, colMap.totalCols).getValues()[0];
    if ((rowValues[colMap.base['Cancelled'] - 1] || '') === 'Yes') {
      throw new Error('This request has already been cancelled.');
    }

    var project = rowValues[colMap.base['Project'] - 1];
    var realUser = (Session.getActiveUser().getEmail() || '').toLowerCase();
    var realIsAdmin = IMSAPPROVAL_ADMIN_EMAILS.indexOf(realUser) !== -1;
    var currentUser = (payload.asEmail && realIsAdmin) ? payload.asEmail.toString().trim().toLowerCase() : realUser;
    var isAdmin = IMSAPPROVAL_ADMIN_EMAILS.indexOf(currentUser) !== -1;
    var requesterEmail = (rowValues[colMap.base['UserEmail'] - 1] || '').toString().toLowerCase();
    var cancelPermEmails = imsApprovalGetAccessEmails_(IMSAPPROVAL_ACCESS_TYPES.cancel, project, 'ALL');
    var isCancelGrantee = cancelPermEmails.indexOf(currentUser) !== -1;

    if (!isAdmin && currentUser !== requesterEmail && !isCancelGrantee) {
      throw new Error('Only the original requester, an admin, or a user authorized in Access Control \u2192 Cancel Permission for "' + project + '" can cancel this request.');
    }

    var constructionType = rowValues[colMap.base['Construction Type'] - 1];
    var block = rowValues[colMap.base['Block'] - 1];
    var lot = rowValues[colMap.base['LOT'] - 1];
    var materialName = rowValues[colMap.base['Material Name'] - 1];
    var quantity = rowValues[colMap.base['Quantity'] - 1];

    var cancelDate = new Date();
    if (payload.cancelDate) {
      var parsed = new Date(payload.cancelDate);
      if (!isNaN(parsed.getTime())) cancelDate = parsed;
    }

    var cancelRow = rowValues.slice();
    cancelRow[colMap.base['Cancelled'] - 1] = 'Yes';
    cancelRow[colMap.base['Cancelled By'] - 1] = currentUser;
    cancelRow[colMap.base['Cancelled At'] - 1] = cancelDate;
    cancelRow[colMap.base['Cancel Reason'] - 1] = reason;
    sheet.getRange(targetRow, 1, 1, cancelRow.length).setValues([cancelRow]);

    var qtySync = { synced: false };
    if (quantity !== '' && quantity !== null && quantity !== undefined && Number(quantity) > 0) {
      qtySync = imsApprovalRestoreQtyMaster_(project, constructionType, block, lot, materialName, quantity);
    }

    return { success: true, qtyRestored: qtySync.synced, remainingAfter: qtySync.synced ? qtySync.remaining : null };
  } catch (err) {
    return { success: false, error: err.message };
  } finally {
    lock.releaseLock();
  }
}