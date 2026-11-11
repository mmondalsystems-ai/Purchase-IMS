/**
 * ImsSupabaseSyncWebhook.gs
 *
 * Instant Supabase -> Sheet signal. Supabase calls this web app after a change;
 * the script ignores the request body and simply runs the normal incremental pull.
 * The 1-minute time trigger stays as a safety net.
 *
 * Setup:
 *   1. Run ImsSupabaseSync_createWebhookToken() once and copy the token from the log.
 *   2. Deploy > New deployment > Web app. Execute as: Me. Who has access: Anyone.
 *   3. Copy the /exec URL and add "?token=<TOKEN>" to it.
 *   4. Put that full URL into webhook_triggers.sql and run it in the Supabase SQL Editor.
 *
 * This project already has its own doGet (the old web app), so only doPost is defined here.
 */

function ImsSupabaseSync_createWebhookToken() {
  var props = PropertiesService.getScriptProperties();
  var token = props.getProperty('IMS_SYNC_WEBHOOK_TOKEN');
  if (!token) {
    token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
    props.setProperty('IMS_SYNC_WEBHOOK_TOKEN', token);
  }
  Logger.log('Webhook token: ' + token);
  return token;
}

/** Supabase POSTs here. The payload is never trusted or used; only the token is checked. */
function doPost(e) {
  var expected = PropertiesService.getScriptProperties().getProperty('IMS_SYNC_WEBHOOK_TOKEN');
  var given = e && e.parameter ? e.parameter.token : '';
  if (!expected || given !== expected) {
    return ContentService.createTextOutput('forbidden');
  }
  ImsSupabaseSync_runPull_(false); // incremental, idempotent, guarded by LockService
  return ContentService.createTextOutput('ok');
}
