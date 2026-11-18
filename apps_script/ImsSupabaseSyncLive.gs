/**
 * IMS Purchase Approval Tracker - LIVE Google Sheet <-> Supabase sync.
 *
 * Add this file to the SAME Apps Script project as ImsSupabaseSync.gs (it re-uses
 * ImsSupabaseSync_rpc_ and the SUPABASE_URL / SUPABASE_SERVICE_KEY script properties).
 * Run schema_sync.sql in Supabase first.
 *
 * How it works
 *   Web app            -> Supabase               immediately (the web app writes to Supabase)
 *   Supabase -> Sheet  : a 1-minute time trigger pulls every request that changed
 *                        and updates the matching row (matched by Sr No).
 *   Sheet -> Supabase  : an installable onEdit trigger pushes the edited cells of the
 *                        row to Supabase within a few seconds.
 *
 * Sheet layout
 *   - Tab "Approval Tracker" (change with Script property IMS_SYNC_TAB), headers in row 1.
 *   - Tab "SYNC_MAP" (created automatically): which sheet header is linked to which
 *     Supabase key, and the direction (Both / Pull only / Push only / Off).
 *     Columns that are NOT in SYNC_MAP, or are set to Off, are never read or written,
 *     so you can add your own columns and formulas freely. Cells that contain a formula
 *     are never overwritten by a pull.
 *   - Tab "SYNC_LOG" (created automatically): errors and rejected edits.
 *   - Tab "Material Quantity Master": the Remaining column is refreshed from Supabase.
 *
 * Setup (once): run ImsSupabaseSync_setupLive(), then check the SYNC_MAP tab.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

var ImsSupabaseSync_DEFAULT_TAB = 'Approval Tracker';
var ImsSupabaseSync_MAP_TAB = 'SYNC_MAP';
var ImsSupabaseSync_LOG_TAB = 'SYNC_LOG';
var ImsSupabaseSync_QTY_TAB = 'Material Quantity Master';

var ImsSupabaseSync_REQ_KEYS = [
  'sr_no', 'project', 'planned', 'construction_type', 'block', 'lot', 'material_name',
  'material_type', 'task_name', 'point_of_uses', 'uom', 'quantity', 'estimated_delivery_date', 'status', 'entry_status',
  'cancelled', 'cancelled_by', 'cancelled_at', 'cancel_reason', 'user_email', 'remarks',
  'entry_timestamp'
];
var ImsSupabaseSync_STAGE_KEYS = [
  'approval', 'approval2', 'wbs', 'indent', 'poRate', 'poEntry', 'rateApproval',
  'advancePayment', 'delivery', 'grn', 'truckEntry'
];
var ImsSupabaseSync_STAGE_FIELDS = ['approver', 'planned_at', 'actual_at', 'delay_days', 'status', 'approved_by'];
var ImsSupabaseSync_EXTRA_KEYS = [
  'indent_indentNo', 'poRate_remarks', 'poEntry_vendorName', 'poEntry_poAmount',
  'poEntry_poNo', 'poEntry_paymentTerms', 'poEntry_advancePaymentRequired', 'delivery_challanBillNo'
];

// Header text (normalised: lower case, letters and digits only) -> key, for auto matching.
var ImsSupabaseSync_ALIASES = {
  'srno': 'sr_no', 'srnumber': 'sr_no', 'serialno': 'sr_no',
  'materialname': 'material_name', 'materialtype': 'material_type',
  'constructiontype': 'construction_type', 'qty': 'quantity',
  'estimateddeliverydate': 'estimated_delivery_date', 'deliverydate': 'estimated_delivery_date',
  'useremail': 'user_email', 'email': 'user_email', 'timestamp': 'entry_timestamp',
  'entrytimestamp': 'entry_timestamp', 'cancelreason': 'cancel_reason',
  'cancelledby': 'cancelled_by', 'cancelledat': 'cancelled_at', 'entrystatus': 'entry_status',
  'pointofusage': 'point_of_uses', 'pointofuse': 'point_of_uses', 'pointofuses': 'point_of_uses'
};

var ImsSupabaseSync_ROW_MODE_MAX = 25;   // more changed rows than this -> column batch mode
var ImsSupabaseSync_LOG_MAX_ROWS = 2000;

// ---------------------------------------------------------------------------
// Setup and menu
// ---------------------------------------------------------------------------

/** Run once. Creates the SYNC_MAP / SYNC_LOG tabs and the three triggers. */
function ImsSupabaseSync_setupLive() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var tab = ImsSupabaseSync_trackerSheet_(true);
  ImsSupabaseSync_buildMap_(tab);
  ImsSupabaseSync_logSheet_();

  var handlers = ['ImsSupabaseSync_onEdit', 'ImsSupabaseSync_onOpen', 'ImsSupabaseSync_pullTrigger'];
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (handlers.indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('ImsSupabaseSync_onEdit').forSpreadsheet(ss).onEdit().create();
  ScriptApp.newTrigger('ImsSupabaseSync_onOpen').forSpreadsheet(ss).onOpen().create();
  ScriptApp.newTrigger('ImsSupabaseSync_pullTrigger').timeBased().everyMinutes(1).create();

  ss.toast('Live sync is set up. Check the SYNC_MAP tab, then use IMS Sync > Pull ALL once.', 'IMS Sync', 10);
}

/** Installable onOpen trigger: adds the IMS Sync menu. */
function ImsSupabaseSync_onOpen() {
  SpreadsheetApp.getUi().createMenu('IMS Sync')
    .addItem('Pull latest from Supabase now', 'ImsSupabaseSync_pullNow')
    .addItem('Pull ALL rows (full refresh)', 'ImsSupabaseSync_pullAllNow')
    .addItem('Push selected rows to Supabase', 'ImsSupabaseSync_pushSelectedRows')
    .addSeparator()
    .addItem('Push masters to Supabase', 'ImsSupabaseSync_pushMastersNow')
    .addItem('Push masters (overwrite Remaining)', 'ImsSupabaseSync_pushMastersOverwriteRemaining')
    .addSeparator()
    .addItem('Rebuild SYNC_MAP from headers', 'ImsSupabaseSync_rebuildMap')
    .addItem('Set up live sync (triggers)', 'ImsSupabaseSync_setupLive')
    .addToUi();
}

function ImsSupabaseSync_rebuildMap() {
  ImsSupabaseSync_buildMap_(ImsSupabaseSync_trackerSheet_(true));
  SpreadsheetApp.getActiveSpreadsheet().toast('SYNC_MAP rebuilt. Check column B.', 'IMS Sync', 8);
}

// ---------------------------------------------------------------------------
// Supabase -> Sheet (1-minute trigger)
// ---------------------------------------------------------------------------

function ImsSupabaseSync_pullNow() {
  ImsSupabaseSync_runPull_(false);
  SpreadsheetApp.getActiveSpreadsheet().toast('Pull finished.', 'IMS Sync', 4);
}

function ImsSupabaseSync_pullAllNow() {
  ImsSupabaseSync_runPull_(true);
  SpreadsheetApp.getActiveSpreadsheet().toast('Full pull finished.', 'IMS Sync', 6);
}

/** Time trigger entry point (every minute). */
function ImsSupabaseSync_pullTrigger() {
  ImsSupabaseSync_runPull_(false);
}

function ImsSupabaseSync_runPull_(forceFull) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return; // another run (pull or push) is busy; the next minute catches up
  try {
    ImsSupabaseSync_retryPending_();
    ImsSupabaseSync_pull_(forceFull);
  } catch (err) {
    ImsSupabaseSync_log_('ERROR', 'Pull failed: ' + err.message);
  } finally {
    lock.releaseLock();
  }
}

function ImsSupabaseSync_pull_(forceFull) {
  var props = PropertiesService.getScriptProperties();
  var since = forceFull ? null : props.getProperty('IMS_SYNC_SINCE');
  var sheet = ImsSupabaseSync_trackerSheet_(false);
  if (!sheet) {
    ImsSupabaseSync_log_('ERROR', 'Tab "' + ImsSupabaseSync_trackerName_() + '" was not found.');
    return;
  }

  if (!since) {
    // Full pull, paged by Sr No.
    var afterSr = 0, firstNow = null, page;
    do {
      page = ImsSupabaseSync_rpc_('ims_changes_since', { p_since: null, p_after_sr: afterSr, p_limit: 200 });
      if (!firstNow) firstNow = page.now;
      if (page.requests && page.requests.length) {
        ImsSupabaseSync_applyRequests_(sheet, page.requests);
        afterSr = page.requests[page.requests.length - 1].sr_no;
      }
      if (page.qty && page.qty.length) ImsSupabaseSync_applyQty_(page.qty);
    } while (page.requests && page.requests.length >= 200);
    props.setProperty('IMS_SYNC_SINCE', firstNow);
    return;
  }

  var res = ImsSupabaseSync_rpc_('ims_changes_since', { p_since: since, p_after_sr: 0, p_limit: 200 });
  if (res.requests && res.requests.length) ImsSupabaseSync_applyRequests_(sheet, res.requests);
  if (res.qty && res.qty.length) ImsSupabaseSync_applyQty_(res.qty);
  props.setProperty('IMS_SYNC_SINCE', res.now);
}

/**
 * Delay (days) columns must be plain numbers. Sheets sometimes formats them as date-time, which
 * shows 0 as "30-Dec-1899 12:00 AM". This sets the number format of every *_delay_days column.
 * Delay = Planned - Actual in days with 2 decimals (time counts), so a stage approved AFTER its planned time is negative.
 */
function ImsSupabaseSync_formatDelayCols_(sheet, entries) {
  var rows = Math.max(sheet.getMaxRows() - 1, 1);
  (entries || []).forEach(function (e) {
    if (/_delay_days$/.test(e.key)) sheet.getRange(2, e.col, rows, 1).setNumberFormat('0.00');
  });
}

/** One-off: run this from the editor to fix the format of all Delay (days) columns right now. */
function ImsSupabaseSync_fixDelayFormat() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(ImsSupabaseSync_DEFAULT_TAB);
  var info = ImsSupabaseSync_readMap_(sheet);
  ImsSupabaseSync_formatDelayCols_(sheet, info.entries);
  SpreadsheetApp.getActiveSpreadsheet().toast('Delay (days) columns are now plain numbers.', 'IMS Sync', 5);
}

/** Writes changed requests into the tracker tab (matched by Sr No). */
function ImsSupabaseSync_applyRequests_(sheet, requests) {
  var info = ImsSupabaseSync_readMap_(sheet);
  if (!info.srCol) {
    ImsSupabaseSync_log_('ERROR', 'SYNC_MAP has no usable row for key sr_no. Pull skipped.');
    return;
  }
  var pull = info.entries.filter(function (e) { return e.pull && e.key !== 'sr_no'; });
  ImsSupabaseSync_formatDelayCols_(sheet, info.entries);
  var tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  var pending = ImsSupabaseSync_getPending_();
  var lastCol = Math.max(sheet.getLastColumn(), 1);
  var lastRow = sheet.getLastRow();
  var n = Math.max(lastRow - 1, 0);

  // Sr No -> sheet row
  var srVals = n > 0 ? sheet.getRange(2, info.srCol, n, 1).getValues() : [];
  var rowBySr = {};
  var lastDataRow = 1;
  for (var i = 0; i < srVals.length; i++) {
    var sr = Number(srVals[i][0]);
    if (sr) { rowBySr[sr] = i + 2; lastDataRow = i + 2; }
  }

  var existing = [], created = [];
  requests.forEach(function (req) {
    if (pending[req.sr_no]) return; // local edit not pushed yet: do not overwrite it
    if (rowBySr[req.sr_no]) existing.push(req); else created.push(req);
  });

  ImsSupabaseSync_log_('INFO', 'Pull: ' + requests.length + ' request(s) from Supabase, ' + existing.length +
    ' existing row(s) to update, ' + created.length + ' new row(s) to append, mapped pull columns=' + pull.length +
    ', last data row=' + lastDataRow + ', pending-skipped=' + (requests.length - existing.length - created.length));

  // ---- update existing rows ----
  if (existing.length > ImsSupabaseSync_ROW_MODE_MAX && n > 0) {
    // Column batch mode: one read, one write per changed column.
    var data = sheet.getRange(2, 1, n, lastCol).getValues();
    var forms = sheet.getRange(2, 1, n, lastCol).getFormulas();
    var dirtyCols = {};
    existing.forEach(function (req) {
      var idx = rowBySr[req.sr_no] - 2;
      pull.forEach(function (en) {
        if (forms[idx][en.col - 1]) return;
        if (!(en.key in req)) return;
        if (!ImsSupabaseSync_same_(data[idx][en.col - 1], req[en.key], en.key, tz)) {
          data[idx][en.col - 1] = ImsSupabaseSync_toCell_(req[en.key]);
          dirtyCols[en.col] = true;
        }
      });
    });
    Object.keys(dirtyCols).forEach(function (c) {
      var col = Number(c), out = [];
      for (var r = 0; r < n; r++) out.push([forms[r][col - 1] ? forms[r][col - 1] : data[r][col - 1]]);
      sheet.getRange(2, col, n, 1).setValues(out);
    });
  } else {
    // Row mode: touch only the cells that differ, grouped into runs of adjacent columns.
    existing.forEach(function (req) {
      var row = rowBySr[req.sr_no];
      var cols = pull.map(function (en) { return en.col; });
      if (!cols.length) return;
      var minC = Math.min.apply(null, cols), maxC = Math.max.apply(null, cols);
      var vals = sheet.getRange(row, minC, 1, maxC - minC + 1).getValues()[0];
      var fs = sheet.getRange(row, minC, 1, maxC - minC + 1).getFormulas()[0];
      var diff = [];
      pull.forEach(function (en) {
        var k = en.col - minC;
        if (fs[k] || !(en.key in req)) return;
        if (!ImsSupabaseSync_same_(vals[k], req[en.key], en.key, tz)) diff.push({ col: en.col, v: ImsSupabaseSync_toCell_(req[en.key]) });
      });
      diff.sort(function (a, b) { return a.col - b.col; });
      var run = [];
      var flush = function () {
        if (!run.length) return;
        sheet.getRange(row, run[0].col, 1, run.length).setValues([run.map(function (x) { return x.v; })]);
        run = [];
      };
      diff.forEach(function (d) {
        if (run.length && d.col !== run[run.length - 1].col + 1) flush();
        run.push(d);
      });
      flush();
    });
  }

  // ---- append new rows ----
  if (created.length) {
    created.sort(function (a, b) { return a.sr_no - b.sr_no; });
    var rows = created.map(function (req) {
      var arr = [];
      for (var c = 0; c < lastCol; c++) arr.push('');
      arr[info.srCol - 1] = req.sr_no;
      pull.forEach(function (en) {
        if (en.key in req) arr[en.col - 1] = ImsSupabaseSync_toCell_(req[en.key]);
      });
      return arr;
    });
    sheet.getRange(lastDataRow + 1, 1, rows.length, lastCol).setValues(rows);
  }
}

/** Column indexes (0-based, -1 = missing) of the Material Quantity Master tab, found by header text. */
function ImsSupabaseSync_qtyCols_(headerRow) {
  var want = {
    status: 'Material Status', ctype: 'Construction Type', block: 'Block', lot: 'LOT',
    material: 'Material Name', uom: 'UOM', total: 'Total Qty (Fixed)', remaining: 'Remaining', project: 'Project'
  };
  var out = {};
  Object.keys(want).forEach(function (k) {
    out[k] = -1;
    for (var i = 0; i < headerRow.length; i++) {
      if (String(headerRow[i] === null ? '' : headerRow[i]).trim().toLowerCase() === want[k].toLowerCase()) { out[k] = i; break; }
    }
  });
  return out;
}

/** Refreshes the Remaining column of the Material Quantity Master tab (column found by header). */
function ImsSupabaseSync_applyQty_(qtyRows) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(ImsSupabaseSync_QTY_TAB);
  if (!sheet) return;
  var last = sheet.getLastRow(), lastCol = sheet.getLastColumn();
  if (last < 2 || lastCol < 1) return;
  var header = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var c = ImsSupabaseSync_qtyCols_(header);
  if (c.remaining < 0 || c.material < 0 || c.project < 0) return;
  var g = function (r, k) { return c[k] >= 0 ? r[c[k]] : ''; };
  var values = sheet.getRange(2, 1, last - 1, lastCol).getValues();
  var forms = sheet.getRange(2, c.remaining + 1, last - 1, 1).getFormulas();
  var rowByCombo = {}, seen = {};
  for (var i = 0; i < values.length; i++) {
    var r = values[i];
    var material = ImsSupabaseSync_text_(g(r, 'material'));
    var project = ImsSupabaseSync_text_(g(r, 'project'));
    if (!material && !project) continue;
    var combo = [project, ImsSupabaseSync_text_(g(r, 'ctype')), ImsSupabaseSync_text_(g(r, 'block')),
                 ImsSupabaseSync_text_(g(r, 'lot')), material].join('\u0001');
    seen[combo] = (seen[combo] || 0) + 1;
    rowByCombo[combo + '\u0002' + seen[combo]] = i;
  }
  qtyRows.forEach(function (q) {
    var combo = [q.project, q.construction_type, q.block, q.lot, q.material_name].join('\u0001');
    var idx = rowByCombo[combo + '\u0002' + q.dup_no];
    if (idx === undefined || forms[idx][0]) return;
    var current = values[idx][c.remaining];
    var next = (q.remaining === null || q.remaining === undefined) ? '' : Number(q.remaining);
    if (String(current === '' ? '' : Number(current)) !== String(next)) {
      sheet.getRange(idx + 2, c.remaining + 1).setValue(next);
    }
  });
}

// ---------------------------------------------------------------------------
// Sheet -> Supabase (installable onEdit trigger)
// ---------------------------------------------------------------------------

function ImsSupabaseSync_onEdit(e) {
  try {
    if (!e || !e.range) return;
    var sheet = e.range.getSheet();
    if (sheet.getName() !== ImsSupabaseSync_trackerName_()) return;
    var r1 = Math.max(e.range.getRow(), 2), r2 = e.range.getLastRow();
    if (r2 < 2) return;
    ImsSupabaseSync_pushRange_(sheet, r1, r2, e.range.getColumn(), e.range.getLastColumn());
  } catch (err) {
    ImsSupabaseSync_log_('ERROR', 'onEdit failed: ' + err.message);
  }
}

/** Manual fallback: pushes every pushable column of the selected rows. */
function ImsSupabaseSync_pushSelectedRows() {
  var sheet = SpreadsheetApp.getActiveSheet();
  if (sheet.getName() !== ImsSupabaseSync_trackerName_()) {
    SpreadsheetApp.getUi().alert('Select rows on the "' + ImsSupabaseSync_trackerName_() + '" tab first.');
    return;
  }
  var sel = sheet.getActiveRange();
  var r1 = Math.max(sel.getRow(), 2), r2 = sel.getLastRow();
  if (r2 < 2) return;
  ImsSupabaseSync_pushRange_(sheet, r1, r2, 1, Math.max(sheet.getLastColumn(), 1));
  SpreadsheetApp.getActiveSpreadsheet().toast('Selected rows pushed.', 'IMS Sync', 4);
}

function ImsSupabaseSync_pushRange_(sheet, r1, r2, c1, c2) {
  var info = ImsSupabaseSync_readMap_(sheet);
  if (!info.srCol) return;
  var pushCols = info.entries.filter(function (en) { return en.push && en.key !== 'sr_no' && en.col >= c1 && en.col <= c2; });
  if (!pushCols.length) return;

  var tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  var n = r2 - r1 + 1;
  var srVals = sheet.getRange(r1, info.srCol, n, 1).getValues();
  var block = sheet.getRange(r1, c1, n, c2 - c1 + 1).getValues();

  var jobs = [];
  for (var i = 0; i < n; i++) {
    var sr = Number(srVals[i][0]);
    if (!sr) continue; // rows without a Sr No are created by the web app only
    var changes = {};
    pushCols.forEach(function (en) { changes[en.key] = ImsSupabaseSync_fromCell_(block[i][en.col - c1], en.key, tz); });
    jobs.push({ sr: sr, row: r1 + i, changes: changes });
  }
  if (!jobs.length) return;

  // Mark the rows as "edited locally" right away so a pull running at this moment skips them.
  jobs.forEach(function (job) { ImsSupabaseSync_addPending_(job.sr, job.changes); });

  var lock = LockService.getScriptLock();
  var locked = lock.tryLock(30000);
  try {
    jobs.forEach(function (job) {
      if (!locked) { ImsSupabaseSync_addPending_(job.sr, job.changes); return; }
      ImsSupabaseSync_pushOne_(sheet, info, job.row, job.sr, job.changes);
    });
  } finally {
    if (locked) lock.releaseLock();
  }
}

/** Pushes one row. Network problems keep the change in the pending queue. */
function ImsSupabaseSync_pushOne_(sheet, info, row, sr, changes) {
  ImsSupabaseSync_addPending_(sr, changes); // protects the row from the pull until we are done
  var res;
  try {
    res = ImsSupabaseSync_rpc_('ims_push_row', { p_sr_no: sr, p_changes: changes });
  } catch (err) {
    ImsSupabaseSync_log_('ERROR', 'Push of Sr No ' + sr + ' failed, will retry: ' + err.message);
    return; // stays pending; ImsSupabaseSync_retryPending_ runs every minute
  }
  ImsSupabaseSync_removePending_(sr);

  var errors = (res && res.errors) || [];
  var applied = (res && res.applied) || [];
  var colByKey = {};
  info.entries.forEach(function (en) { colByKey[en.key] = en.col; });

  applied.forEach(function (key) {
    if (colByKey[key]) sheet.getRange(row, colByKey[key]).setNote('');
  });
  if (errors.length) {
    // Put the Supabase value back in the rejected cells and explain why.
    var flat = null;
    try { flat = ImsSupabaseSync_rpc_('ims_flat_request', { p_sr_no: sr }); } catch (ignore) { flat = null; }
    errors.forEach(function (er) {
      ImsSupabaseSync_log_('REJECTED', 'Sr No ' + sr + ', ' + er.key + ': ' + er.message);
      var col = colByKey[er.key];
      if (!col) return;
      var cell = sheet.getRange(row, col);
      if (flat && er.key in flat) cell.setValue(ImsSupabaseSync_toCell_(flat[er.key]));
      cell.setNote('Not saved to Supabase: ' + er.message + (flat ? ' The Supabase value was put back.' : ''));
    });
  }
}

// ---------------------------------------------------------------------------
// Pending queue (pushes that could not reach Supabase)
// ---------------------------------------------------------------------------

function ImsSupabaseSync_getPending_() {
  var raw = PropertiesService.getScriptProperties().getProperty('IMS_SYNC_PENDING');
  try { return raw ? JSON.parse(raw) : {}; } catch (err) { return {}; }
}

function ImsSupabaseSync_setPending_(obj) {
  PropertiesService.getScriptProperties().setProperty('IMS_SYNC_PENDING', JSON.stringify(obj));
}

function ImsSupabaseSync_addPending_(sr, changes) {
  var p = ImsSupabaseSync_getPending_();
  var cur = p[sr] || {};
  Object.keys(changes).forEach(function (k) { cur[k] = changes[k]; });
  p[sr] = cur;
  ImsSupabaseSync_setPending_(p);
}

function ImsSupabaseSync_removePending_(sr) {
  var p = ImsSupabaseSync_getPending_();
  delete p[sr];
  ImsSupabaseSync_setPending_(p);
}

function ImsSupabaseSync_retryPending_() {
  var p = ImsSupabaseSync_getPending_();
  var keys = Object.keys(p);
  if (!keys.length) return;
  var sheet = ImsSupabaseSync_trackerSheet_(false);
  if (!sheet) return;
  var info = ImsSupabaseSync_readMap_(sheet);
  if (!info.srCol) return;
  var last = sheet.getLastRow();
  var srVals = last >= 2 ? sheet.getRange(2, info.srCol, last - 1, 1).getValues() : [];
  var rowBySr = {};
  srVals.forEach(function (v, i) { if (Number(v[0])) rowBySr[Number(v[0])] = i + 2; });
  keys.forEach(function (srKey) {
    var sr = Number(srKey);
    var row = rowBySr[sr];
    if (!row) { ImsSupabaseSync_removePending_(sr); return; }
    ImsSupabaseSync_pushOne_(sheet, info, row, sr, p[srKey]);
  });
}

// ---------------------------------------------------------------------------
// SYNC_MAP
// ---------------------------------------------------------------------------

function ImsSupabaseSync_allKeys_() {
  var keys = ImsSupabaseSync_REQ_KEYS.slice();
  ImsSupabaseSync_STAGE_KEYS.forEach(function (s) {
    ImsSupabaseSync_STAGE_FIELDS.forEach(function (f) { keys.push(s + '_' + f); });
  });
  return keys.concat(ImsSupabaseSync_EXTRA_KEYS);
}

function ImsSupabaseSync_normHeader_(text) {
  return String(text === null || text === undefined ? '' : text).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Header labels used by the tracker tab for stage columns, e.g. "PO Rate Stage - Planned Date". */
function ImsSupabaseSync_stageAliases_() {
  var stageLabels = {
    approval: 'Approval Stage', approval2: '2nd Approval Stage', wbs: 'WBS Stage', indent: 'Indent Stage',
    poRate: 'PO Rate Stage', poEntry: 'PO Preparation Stage', rateApproval: 'Rate Approval Stage',
    advancePayment: 'Advance Payment Stage', delivery: 'Delivery Stage',
    grn: 'GRN Stage', truckEntry: 'Truck Entry Stage'
  };
  var fieldLabels = {
    approver: 'Approver', planned_at: 'Planned Date', actual_at: 'Actual Date',
    delay_days: 'Delay (days)', status: 'Status', approved_by: 'Approved By'
  };
  var extraLabels = {
    indent_indentNo: 'Indent Stage - Indent No',
    poRate_remarks: 'PO Rate Stage - Remarks',
    poEntry_vendorName: 'PO Preparation Stage - Vendor Name',
    poEntry_poAmount: 'PO Preparation Stage - PO Amount',
    poEntry_poNo: 'PO Preparation Stage - PO No',
    poEntry_paymentTerms: 'PO Preparation Stage - Payment Terms',
    poEntry_advancePaymentRequired: 'PO Preparation Stage - Advance Payment Required',
    delivery_challanBillNo: 'Delivery Stage - Challan No./Bill No.'
  };
  var out = {};
  Object.keys(stageLabels).forEach(function (s) {
    Object.keys(fieldLabels).forEach(function (f) {
      out[ImsSupabaseSync_normHeader_(stageLabels[s] + ' ' + fieldLabels[f])] = s + '_' + f;
    });
  });
  Object.keys(extraLabels).forEach(function (k) {
    out[ImsSupabaseSync_normHeader_(extraLabels[k])] = k;
  });
  // Older sheets still carry the "PO Entry Stage" headers for the same stage; match them too.
  Object.keys(fieldLabels).forEach(function (f) {
    out[ImsSupabaseSync_normHeader_('PO Entry Stage ' + fieldLabels[f])] = 'poEntry_' + f;
  });
  out[ImsSupabaseSync_normHeader_('PO Entry Stage - Vendor Name')] = 'poEntry_vendorName';
  out[ImsSupabaseSync_normHeader_('PO Entry Stage - PO Amount')] = 'poEntry_poAmount';
  return out;
}

/** Creates SYNC_MAP from the headers of the tracker tab (keeps existing choices when the header is already listed). */
function ImsSupabaseSync_buildMap_(tracker) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var keys = ImsSupabaseSync_allKeys_();
  var byNorm = {};
  keys.forEach(function (k) { byNorm[ImsSupabaseSync_normHeader_(k)] = k; });
  Object.keys(ImsSupabaseSync_ALIASES).forEach(function (a) { byNorm[a] = ImsSupabaseSync_ALIASES[a]; });
  var stageAliases = ImsSupabaseSync_stageAliases_();
  Object.keys(stageAliases).forEach(function (a) { byNorm[a] = stageAliases[a]; });

  var headers = tracker.getLastColumn() > 0 ? tracker.getRange(1, 1, 1, tracker.getLastColumn()).getValues()[0] : [];
  if (!headers.length || headers.every(function (h) { return String(h).trim() === ''; })) {
    tracker.getRange(1, 1, 1, keys.length).setValues([keys]);
    headers = keys.slice();
  }

  var mapSheet = ss.getSheetByName(ImsSupabaseSync_MAP_TAB) || ss.insertSheet(ImsSupabaseSync_MAP_TAB);
  var previous = {};
  var lastMapRow = mapSheet.getLastRow();
  if (lastMapRow >= 2) {
    mapSheet.getRange(2, 1, lastMapRow - 1, 3).getValues().forEach(function (r) {
      var h = String(r[0]).trim();
      if (h) previous[h] = { key: String(r[1]).trim(), dir: String(r[2]).trim() };
    });
  }

  var rows = [];
  headers.forEach(function (h) {
    var text = String(h).trim();
    if (!text) return;
    if (previous[text] && previous[text].key) { rows.push([text, previous[text].key, previous[text].dir || 'Both']); return; }
    var key = byNorm[ImsSupabaseSync_normHeader_(text)] || '';
    var dir = !key ? 'Off' : (key === 'sr_no' || key === 'entry_timestamp') ? 'Pull only' : 'Both';
    rows.push([text, key, dir]);
  });

  mapSheet.getRange(1, 1, 1, 3).setValues([['Sheet header', 'Supabase key', 'Direction']]).setFontWeight('bold');
  var oldCount = Math.max(lastMapRow - 1, 0);
  if (oldCount > rows.length) mapSheet.getRange(2 + rows.length, 1, oldCount - rows.length, 3).clearContent();
  if (rows.length) mapSheet.getRange(2, 1, rows.length, 3).setValues(rows);
  if (rows.length) {
    var rule = SpreadsheetApp.newDataValidation()
      .requireValueInList(['Both', 'Pull only', 'Push only', 'Off'], true).setAllowInvalid(false).build();
    mapSheet.getRange(2, 3, rows.length, 1).setDataValidation(rule);
  }
  mapSheet.getRange('E1').setValue(
    'Column A = header in the tracker tab. Column B = Supabase key (leave blank + Off if not synced). ' +
    'Direction: Both / Pull only (Supabase -> sheet) / Push only (sheet -> Supabase) / Off. ' +
    'Valid keys: sr_no, request fields, <stage>_approver|planned_at|actual_at|delay_days|status|approved_by, and stage extras such as indent_indentNo.');
  return mapSheet;
}

/** Returns { entries: [{col,key,pull,push}], srCol } resolved against the current header row. */
function ImsSupabaseSync_readMap_(sheet) {
  var ss = sheet.getParent();
  var mapSheet = ss.getSheetByName(ImsSupabaseSync_MAP_TAB) || ImsSupabaseSync_buildMap_(sheet);
  var last = mapSheet.getLastRow();
  var rows = last >= 2 ? mapSheet.getRange(2, 1, last - 1, 3).getValues() : [];
  var lastCol = Math.max(sheet.getLastColumn(), 1);
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var colByHeader = {};
  headers.forEach(function (h, i) {
    var t = String(h).trim();
    if (t && !(t in colByHeader)) colByHeader[t] = i + 1;
  });
  var entries = [], srCol = 0;
  rows.forEach(function (r) {
    var header = String(r[0]).trim(), key = String(r[1]).trim(), dir = String(r[2]).trim().toLowerCase();
    if (!header || !key || dir === 'off' || dir === '') return;
    var col = colByHeader[header];
    if (!col) return;
    var entry = { col: col, key: key, header: header, pull: dir === 'both' || dir === 'pull only', push: dir === 'both' || dir === 'push only' };
    if (key === 'sr_no') srCol = col;
    entries.push(entry);
  });
  return { entries: entries, srCol: srCol };
}

// ---------------------------------------------------------------------------
// Value helpers
// ---------------------------------------------------------------------------

function ImsSupabaseSync_isDateKey_(key) { return key === 'estimated_delivery_date'; }
function ImsSupabaseSync_isTsKey_(key) { return key === 'entry_timestamp' || /_at$/.test(key); }

/** Supabase JSON value -> value to write into a cell. */
function ImsSupabaseSync_toCell_(v) {
  if (v === null || v === undefined) return '';
  return v;
}

/** Cell value -> JSON value for ims_push_row. */
function ImsSupabaseSync_fromCell_(v, key, tz) {
  if (v === null || v === undefined || v === '') return '';
  if (v instanceof Date) {
    return Utilities.formatDate(v, tz, ImsSupabaseSync_isDateKey_(key) ? 'yyyy-MM-dd' : 'yyyy-MM-dd HH:mm:ss');
  }
  if (typeof v === 'string') return v.trim();
  return v;
}

function ImsSupabaseSync_norm_(v, key, tz) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) {
    return Utilities.formatDate(v, tz, ImsSupabaseSync_isDateKey_(key) ? 'yyyy-MM-dd' : 'yyyy-MM-dd HH:mm:ss');
  }
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  var s = String(v).trim();
  var low = s.toLowerCase();
  if (low === 'true' || low === 'false') return low;
  return s;
}

function ImsSupabaseSync_same_(cellValue, dbValue, key, tz) {
  return ImsSupabaseSync_norm_(cellValue, key, tz) === ImsSupabaseSync_norm_(dbValue, key, tz);
}

// ---------------------------------------------------------------------------
// Sheets and log
// ---------------------------------------------------------------------------

function ImsSupabaseSync_trackerName_() {
  return PropertiesService.getScriptProperties().getProperty('IMS_SYNC_TAB') || ImsSupabaseSync_DEFAULT_TAB;
}

function ImsSupabaseSync_trackerSheet_(createIfMissing) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var name = ImsSupabaseSync_trackerName_();
  var sheet = ss.getSheetByName(name);
  if (!sheet && createIfMissing) sheet = ss.insertSheet(name);
  return sheet;
}

function ImsSupabaseSync_logSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(ImsSupabaseSync_LOG_TAB);
  if (!sheet) {
    sheet = ss.insertSheet(ImsSupabaseSync_LOG_TAB);
    sheet.getRange(1, 1, 1, 3).setValues([['Time', 'Level', 'Message']]).setFontWeight('bold');
  }
  return sheet;
}

function ImsSupabaseSync_log_(level, message) {
  try {
    var sheet = ImsSupabaseSync_logSheet_();
    sheet.appendRow([new Date(), level, message]);
    var last = sheet.getLastRow();
    if (last > ImsSupabaseSync_LOG_MAX_ROWS) sheet.deleteRows(2, last - ImsSupabaseSync_LOG_MAX_ROWS + 500);
  } catch (err) {
    Logger.log(level + ': ' + message);
  }
}
