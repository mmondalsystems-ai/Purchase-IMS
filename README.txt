IMS PURCHASE APPROVAL TRACKER - Python (FastAPI) + Supabase
============================================================
Same logic and same function names as the Apps Script (Approval_Code.gs). The page
(ApprovalIndex.html) is unchanged; static/shim.js sends google.script.run calls to POST /api/<function>.

1) SUPABASE
   - Supabase > SQL Editor: paste and run schema.sql (safe to run again).
   - Project Settings > Database > Connection string > "Transaction pooler" -> DATABASE_URL.

2) LOCAL SETUP
   pip install -r requirements.txt
   copy .env.example to .env and fill: DATABASE_URL, SECRET_KEY (long random), GOOGLE_CLIENT_ID,
   ALLOWED_DOMAINS (default oswalgroup.net), ADMIN_EMAILS.
   Google Cloud Console > APIs & Services > Credentials > OAuth client ID (Web).
   Add your site URL (http://localhost:8000 and the live URL) to "Authorized JavaScript origins".

3) IMPORT MASTER TABS (one time; repeatable)
   Download the sheet as Excel, then:
   python import_masters.py Purchase_IMS_Backend.xlsx
   (--reset-remaining forces Remaining from the sheet; --only people,vendors,... for a subset)

4) RUN
   uvicorn app:app --reload          -> http://localhost:8000
   Health check: /health

5) ONGOING SHEET -> SUPABASE SYNC (optional)
   Add apps_script/ImsSupabaseSync.gs to the sheet's Apps Script project, set Script properties
   SUPABASE_URL and SUPABASE_SERVICE_KEY, run ImsSupabaseSync_pushMastersNow, optionally
   ImsSupabaseSync_createHourlyTrigger.

6) GITHUB
   .env and xlsx are git-ignored. NEVER commit DATABASE_URL, service_role key or SECRET_KEY
   (the repo is public) - keep them only in host environment variables.

7) DEPLOY (when ready)
   Start command: uvicorn app:app --host 0.0.0.0 --port $PORT
   Set the same env vars on the host; health path /health.
   AWS App Runner: separate new service, own region/VPC-free, min 1 instance.

8) TESTS
   APP_ENV=dev DATABASE_URL=... python tests/smoke_test.py   (needs an empty test DB with schema.sql)

Deliberate differences vs Apps Script: Planned qty > Remaining is rejected; everything is
transactional; cancel restores qty only for Planned; StartFlow only for requester/admin;
Advance Payment can't be approved when not required; no Sr No gaps on rejected submits.
