/**
 * PO Tracker tab (one PO = one row), pulled one-way from Supabase.
 * Separate file: it does not touch ImsSupabaseSyncLive.gs. It reuses ImsSupabaseSync_rpc_ from that file.
 * The tab "PO Tracker" is owned by this script: every refresh rewrites ONLY that tab's data range.
 * Use: run ImsPoTracker_setup() once (creates the tab, a 5-minute refresh trigger and the "PO Tracker" menu).
 */
var IMS_PO_TRACKER_TAB = 'PO Tracker';
var IMS_PO_TRACKER_STAGES = [
  ['rateApproval', 'Rate Approval'], ['advancePayment', 'Advance Payment'], ['delivery', 'Delivery'],
  ['grn', 'GRN'], ['truckEntry', 'Truck Entry']
];

function ImsPoTracker_headers_() {
  var h = ['PO ID', 'PO No', 'Project', 'Supplier Name', 'Indent Nos', 'Materials', 'PO Amount', 'Advance Required', 'Status',
           'Created At', 'Cancelled At', 'Cancel Reason'];
  IMS_PO_TRACKER_STAGES.forEach(function (s) {
    h.push(s[1] + ' Planned', s[1] + ' Actual', s[1] + ' Status', s[1] + ' Delay');
  });
  return h;
}

function ImsPoTracker_refresh() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(IMS_PO_TRACKER_TAB) || ss.insertSheet(IMS_PO_TRACKER_TAB);
  var res = ImsSupabaseSync_rpc_('ims_po_tracker', {});
  var rows = (res || []).map(function (p) {
    var line = [p.poId, p.poNo, p.project, p.supplier, p.indentNos, p.materials, p.poAmount, p.advance, p.status,
                p.createdAt, p.cancelledAt, p.cancelReason];
    IMS_PO_TRACKER_STAGES.forEach(function (s) {
      var st = (p.stages || {})[s[0]] || {};
      line.push(st.planned || '', st.actual || '', st.status || '', st.delay || '');
    });
    return line;
  });
  var headers = ImsPoTracker_headers_();
  // Keep every value as text so the sheet never turns a PO No or an amount into a date.
  var width = headers.length;
  sheet.getRange(1, 1, 1, width).setValues([headers]).setFontWeight('bold').setBackground('#e8f0fe');
  sheet.setFrozenRows(1);
  var oldLast = sheet.getLastRow();
  if (oldLast > 1) sheet.getRange(2, 1, oldLast - 1, width).clearContent();
  if (rows.length) {
    var range = sheet.getRange(2, 1, rows.length, width);
    range.setNumberFormat('@');
    range.setValues(rows.map(function (r) { return r.map(function (v) { return v === null || v === undefined ? '' : String(v); }); }));
  }
  return rows.length;
}

function ImsPoTracker_refreshNow() {
  var n = ImsPoTracker_refresh();
  SpreadsheetApp.getActiveSpreadsheet().toast(n + ' PO(s) refreshed.', 'PO Tracker', 5);
}

function ImsPoTracker_onOpen() {
  SpreadsheetApp.getUi().createMenu('PO Tracker').addItem('Refresh PO Tracker now', 'ImsPoTracker_refreshNow').addToUi();
}

function ImsPoTracker_timer() {
  try { ImsPoTracker_refresh(); } catch (e) { console.error('PO Tracker refresh failed: ' + e); }
}

function ImsPoTracker_setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (['ImsPoTracker_timer', 'ImsPoTracker_onOpen'].indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('ImsPoTracker_onOpen').forSpreadsheet(ss).onOpen().create();
  ScriptApp.newTrigger('ImsPoTracker_timer').timeBased().everyMinutes(5).create();
  var n = ImsPoTracker_refresh();
  ss.toast('PO Tracker is set up (' + n + ' PO rows). It refreshes every 5 minutes.', 'PO Tracker', 8);
}
