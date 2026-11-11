/**
 * ImsSupabaseSyncDebug.gs
 * Diagnostics only. Run ImsSupabaseSync_debugPull from the editor and read SYNC_LOG.
 * It changes nothing in the tracker tab or in Supabase.
 */
function ImsSupabaseSync_debugPull() {
  var props = PropertiesService.getScriptProperties();
  var sheet = ImsSupabaseSync_trackerSheet_(false);
  ImsSupabaseSync_log_('INFO', 'DEBUG tracker tab found: ' + (sheet ? sheet.getName() : 'NO'));
  if (!sheet) return;
  var info = ImsSupabaseSync_readMap_(sheet);
  ImsSupabaseSync_log_('INFO', 'DEBUG srCol=' + info.srCol + ', mapped entries=' + info.entries.length +
    ', pull entries=' + info.entries.filter(function (e) { return e.pull; }).length);
  ImsSupabaseSync_log_('INFO', 'DEBUG lastRow=' + sheet.getLastRow() + ', lastCol=' + sheet.getLastColumn());
  ImsSupabaseSync_log_('INFO', 'DEBUG IMS_SYNC_SINCE=' + props.getProperty('IMS_SYNC_SINCE'));
  ImsSupabaseSync_log_('INFO', 'DEBUG IMS_SYNC_PENDING=' + props.getProperty('IMS_SYNC_PENDING'));
  var res = ImsSupabaseSync_rpc_('ims_changes_since', { p_since: null, p_after_sr: 0, p_limit: 5 });
  ImsSupabaseSync_log_('INFO', 'DEBUG rpc requests=' + (res.requests ? res.requests.length : 'none') +
    ', qty=' + (res.qty ? res.qty.length : 'none'));
}

/** Clears the pending-push queue (use only if debug shows stale entries blocking the pull). */
function ImsSupabaseSync_clearPending() {
  PropertiesService.getScriptProperties().deleteProperty('IMS_SYNC_PENDING');
  ImsSupabaseSync_log_('INFO', 'Pending queue cleared.');
}
