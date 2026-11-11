/**
 * IMS PURCHASE APPROVAL TRACKER -> SUPABASE MASTER SYNC
 *
 * Add this file to the Apps Script project that is bound to the "Purchase IMS Backend"
 * spreadsheet. It copies the MASTER tabs into Supabase so the Python web app sees every
 * change you make in the sheet:
 *
 *     People, Vendor Master, Material Master, Stage Config, Access Control,
 *     Material Quantity Master
 *
 * It never touches "Approval Tracker" - requests now live only in Supabase.
 *
 * Setup (once)
 *   1. Project Settings > Script properties, add:
 *        SUPABASE_URL          = https://YOUR-PROJECT-REF.supabase.co
 *        SUPABASE_SERVICE_KEY  = the service_role key (Supabase > Project Settings > API)
 *      The service_role key bypasses all security. Keep it ONLY in Script properties.
 *   2. Run ImsSupabaseSync_pushMastersNow() once and accept the permissions.
 *   3. Optional: run ImsSupabaseSync_createHourlyTrigger() to repeat it every hour.
 *
 * Rules (the same SQL function as the Python importer, so both behave the same)
 *   - People and Stage Config: sheet value wins.
 *   - Vendor Master and Material Master: only new names are added.
 *   - Access Control: replaced by the sheet.
 *   - Material Quantity Master: new rows are added; Total Qty and Material Status are
 *     updated; Remaining of existing rows is NOT overwritten because the web app deducts
 *     from it. Use ImsSupabaseSync_pushMastersOverwriteRemaining() to force the sheet's
 *     Remaining values (for example after a BOQ correction).
 */

var IMSSUPABASESYNC_QTY_CHUNK = 1500;

function ImsSupabaseSync_pushMastersNow() {
  ImsSupabaseSync_run_(false);
}

function ImsSupabaseSync_pushMastersOverwriteRemaining() {
  ImsSupabaseSync_run_(true);
}

function ImsSupabaseSync_run_(overwriteRemaining) {
  var started = new Date();

  var small = {
    people: ImsSupabaseSync_buildPeople_(),
    vendors: ImsSupabaseSync_buildSingleColumn_('Vendor Master'),
    materials: ImsSupabaseSync_buildSingleColumn_('Material Master'),
    stage_config: ImsSupabaseSync_buildStageConfig_(),
    access_control: ImsSupabaseSync_buildAccessControl_()
  };
  var res = ImsSupabaseSync_rpc_('ims_sync_masters', { p: small, overwrite_remaining: false });
  Logger.log('Small masters: ' + JSON.stringify(res));

  var qty = ImsSupabaseSync_buildQtyMaster_();
  for (var i = 0; i < qty.length; i += IMSSUPABASESYNC_QTY_CHUNK) {
    var chunk = qty.slice(i, i + IMSSUPABASESYNC_QTY_CHUNK);
    ImsSupabaseSync_rpc_('ims_sync_masters', { p: { qty_master: chunk }, overwrite_remaining: !!overwriteRemaining });
  }
  Logger.log('Material Quantity Master rows sent: ' + qty.length + (overwriteRemaining ? ' (Remaining overwritten)' : ''));
  Logger.log('Finished in ' + ((new Date() - started) / 1000) + ' seconds.');
}

/** Creates (or replaces) an hourly trigger for ImsSupabaseSync_pushMastersNow. */
function ImsSupabaseSync_createHourlyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'ImsSupabaseSync_pushMastersNow') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('ImsSupabaseSync_pushMastersNow').timeBased().everyHours(1).create();
}

// ---------------------------------------------------------------------------
// Supabase call
// ---------------------------------------------------------------------------

function ImsSupabaseSync_rpc_(fnName, body) {
  var props = PropertiesService.getScriptProperties();
  var url = (props.getProperty('SUPABASE_URL') || '').replace(/\/+$/, '');
  var key = props.getProperty('SUPABASE_SERVICE_KEY');
  if (!url || !key) {
    throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_KEY in Project Settings > Script properties.');
  }
  var resp = UrlFetchApp.fetch(url + '/rest/v1/rpc/' + fnName, {
    method: 'post',
    contentType: 'application/json',
    headers: { apikey: key, Authorization: 'Bearer ' + key },
    payload: JSON.stringify(body),
    muteHttpExceptions: true
  });
  var code = resp.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error('Supabase ' + fnName + ' failed (HTTP ' + code + '): ' + resp.getContentText());
  }
  return JSON.parse(resp.getContentText() || 'null');
}

// ---------------------------------------------------------------------------
// Sheet readers (each returns plain JSON for ims_sync_masters)
// ---------------------------------------------------------------------------

function ImsSupabaseSync_text_(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function ImsSupabaseSync_number_(value) {
  if (value === '' || value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  var n = Number(String(value).replace(/,/g, '').trim());
  return isNaN(n) ? null : n;
}

function ImsSupabaseSync_values_(sheetName) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  if (!sheet) throw new Error('Sheet tab "' + sheetName + '" was not found.');
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow < 1 || lastCol < 1) return [];
  return sheet.getRange(1, 1, lastRow, lastCol).getValues();
}

function ImsSupabaseSync_buildPeople_() {
  var rows = ImsSupabaseSync_values_('People');
  var out = [];
  for (var i = 1; i < rows.length; i++) {
    var name = ImsSupabaseSync_text_(rows[i][0]);
    if (name) out.push({ name: name, email: ImsSupabaseSync_text_(rows[i][1]) });
  }
  return out;
}

function ImsSupabaseSync_buildSingleColumn_(sheetName) {
  var rows = ImsSupabaseSync_values_(sheetName);
  var out = [];
  for (var i = 1; i < rows.length; i++) {
    var v = ImsSupabaseSync_text_(rows[i][0]);
    if (v) out.push(v);
  }
  return out;
}

function ImsSupabaseSync_buildStageConfig_() {
  var rows = ImsSupabaseSync_values_('Stage Config');
  if (!rows.length) return [];
  var header = rows[0];
  var out = [];
  for (var i = 1; i < rows.length; i++) {
    var key = ImsSupabaseSync_text_(rows[i][1]);
    if (!key) continue;
    for (var c = 3; c < header.length; c++) {
      var project = ImsSupabaseSync_text_(header[c]);
      var approver = ImsSupabaseSync_text_(rows[i][c]);
      if (!project || approver.indexOf('(computed') === 0) continue;
      out.push({ stage_key: key, project: project, approver: approver });
    }
  }
  return out;
}

function ImsSupabaseSync_buildAccessControl_() {
  var rows = ImsSupabaseSync_values_('Access Control');
  var out = [];
  for (var i = 1; i < rows.length; i++) {
    var cells = [];
    for (var c = 0; c < 5; c++) cells.push(ImsSupabaseSync_text_(rows[i][c]));
    if (!cells.join('')) continue;
    out.push({
      access_types: cells[0], projects: cells[1], stage_keys: cells[2],
      notes: cells[3], names_emails: cells[4]
    });
  }
  return out;
}

function ImsSupabaseSync_buildQtyMaster_() {
  var rows = ImsSupabaseSync_values_('Material Quantity Master');
  var out = [];
  var seen = {};
  for (var i = 1; i < rows.length; i++) {
    var r = rows[i];
    var material = ImsSupabaseSync_text_(r[4]);
    var project = ImsSupabaseSync_text_(r[7]);
    if (!material && !project) continue; // fully blank row
    var combo = [project, ImsSupabaseSync_text_(r[1]), ImsSupabaseSync_text_(r[2]),
                 ImsSupabaseSync_text_(r[3]), material].join('\u0001');
    seen[combo] = (seen[combo] || 0) + 1;
    out.push({
      material_status: ImsSupabaseSync_text_(r[0]),
      construction_type: ImsSupabaseSync_text_(r[1]),
      block: ImsSupabaseSync_text_(r[2]),
      lot: ImsSupabaseSync_text_(r[3]),
      material_name: material,
      total_qty: ImsSupabaseSync_number_(r[5]),
      remaining: ImsSupabaseSync_number_(r[6]),
      project: project,
      dup_no: seen[combo]
    });
  }
  return out;
}
