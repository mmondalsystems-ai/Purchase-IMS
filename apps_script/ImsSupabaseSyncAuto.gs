/**
 * IMS -> SUPABASE AUTO SYNC FOR THREE MASTER TABS
 *
 * Watches "Vendor Master", "Material Master" and "Task Master". When the values on any of
 * them change (typed by hand OR produced by a formula), the new values are sent to Supabase
 * automatically, within about a minute.
 *
 * Why a one-minute check instead of an onEdit trigger: onEdit does NOT fire when a formula
 * result changes or when data is pasted by another script. Comparing a fingerprint of the
 * sheet values every minute catches every kind of change, and it only calls Supabase when
 * something really changed.
 *
 * Manual edits are pushed within a few seconds (installable onEdit trigger). Formula results
 * and script-made changes are caught by the one-minute check (Apps Script time triggers can
 * not run more often than once a minute).
 *
 * Setup (once): run ImsSupabaseSyncAuto_setup() and accept the permissions.
 * Stop: run ImsSupabaseSyncAuto_remove().
 *
 * Requires ImsSupabaseSync.gs in the same project (readers and the Supabase call).
 * Rules are the same as the manual push: Vendor Master and Material Master only ADD new
 * names in Supabase, Task Master is merged the same way as the manual push.
 */

var IMSAUTO_HASH_PROP = 'IMS_AUTO_MASTERS_HASH';

/** Creates a trigger that runs the check every minute (replaces an older one). */
function ImsSupabaseSyncAuto_setup() {
  ImsSupabaseSyncAuto_remove();
  ScriptApp.newTrigger('ImsSupabaseSyncAuto_check').timeBased().everyMinutes(1).create();
  ScriptApp.newTrigger('ImsSupabaseSyncAuto_onEdit')
    .forSpreadsheet(SpreadsheetApp.getActiveSpreadsheet()).onEdit().create();
  // Force the first check to push once so Supabase starts in sync.
  PropertiesService.getScriptProperties().deleteProperty(IMSAUTO_HASH_PROP);
  ImsSupabaseSyncAuto_check();
}

function ImsSupabaseSyncAuto_remove() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var h = t.getHandlerFunction();
    if (h === 'ImsSupabaseSyncAuto_check' || h === 'ImsSupabaseSyncAuto_onEdit') ScriptApp.deleteTrigger(t);
  });
}

/** Installable onEdit handler: runs the check right away when one of the three tabs is edited. */
function ImsSupabaseSyncAuto_onEdit(e) {
  try {
    var name = e && e.range ? e.range.getSheet().getName() : '';
    if (name === 'Vendor Master' || name === 'Material Master' || name === 'Task Master') {
      ImsSupabaseSyncAuto_check();
    }
  } catch (err) {
    Logger.log('Auto sync onEdit failed: ' + err);
  }
}

/** Sends the three tabs to Supabase only when their values changed since the last run. */
function ImsSupabaseSyncAuto_check() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return; // another run is in progress
  try {
    var payload = {
      vendors: ImsSupabaseSync_buildSingleColumn_('Vendor Master'),
      materials: ImsSupabaseSync_buildSingleColumn_('Material Master'),
      tasks: ImsSupabaseSync_buildTasks_()
    };
    var json = JSON.stringify(payload);
    var hash = Utilities.base64Encode(
      Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, json, Utilities.Charset.UTF_8));

    var props = PropertiesService.getScriptProperties();
    if (props.getProperty(IMSAUTO_HASH_PROP) === hash) return; // nothing changed

    var res = ImsSupabaseSync_rpc_('ims_sync_masters', { p: payload, overwrite_remaining: false });
    props.setProperty(IMSAUTO_HASH_PROP, hash);
    Logger.log('Masters changed - pushed to Supabase: ' + JSON.stringify(res));
  } finally {
    lock.releaseLock();
  }
}
