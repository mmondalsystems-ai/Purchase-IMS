"""
IMS Purchase Approval Tracker - FastAPI server.

  GET  /              the app page (needs sign-in)
  GET  /login         Google sign-in page
  POST /auth/google   verifies the Google ID token, starts a session
  GET  /auth/logout   ends the session
  POST /api/<name>    same functions the page used to call with google.script.run
  GET  /health        health check for the hosting platform
"""
import logging
import os
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.sessions import SessionMiddleware

BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")

import logic  # noqa: E402  (needs the .env loaded first: config reads ADMIN_EMAILS)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("ims.app")

APP_ENV = os.getenv("APP_ENV", "prod").lower()
SECRET_KEY = os.getenv("SECRET_KEY", "")
GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID", "").strip()
ALLOWED_DOMAINS = [d.strip().lower().lstrip("@") for d in os.getenv("ALLOWED_DOMAINS", "oswalgroup.net").split(",") if d.strip()]

if not SECRET_KEY:
    if APP_ENV == "dev":
        SECRET_KEY = "dev-only-secret"
    else:
        raise RuntimeError("SECRET_KEY is not set. Put a long random string in the environment variables.")

app = FastAPI(title="IMS Purchase Approval Tracker", docs_url=None, redoc_url=None, openapi_url=None)
app.add_middleware(
    SessionMiddleware,
    secret_key=SECRET_KEY,
    same_site="lax",
    https_only=(APP_ENV != "dev"),
    max_age=60 * 60 * 12,
    session_cookie="ims_session",
)
app.mount("/static", StaticFiles(directory=str(BASE_DIR / "static")), name="static")


def _read(name: str) -> str:
    return (BASE_DIR / "templates" / name).read_text(encoding="utf-8")


def _current_email(request: Request) -> str:
    return (request.session.get("email") or "").strip().lower()


@app.get("/health")
def health():
    return {"ok": True}


@app.get("/login", response_class=HTMLResponse)
def login_page(request: Request):
    if _current_email(request):
        return RedirectResponse("/")
    html = _read("login.html").replace("__GOOGLE_CLIENT_ID__", GOOGLE_CLIENT_ID)
    html = html.replace("__ALLOWED_DOMAINS__", ", ".join("@" + d for d in ALLOWED_DOMAINS))
    return HTMLResponse(html, headers={"Cache-Control": "no-store"})


@app.post("/auth/google")
async def auth_google(request: Request):
    try:
        body = await request.json()
        credential = (body or {}).get("credential", "")
        if not GOOGLE_CLIENT_ID:
            return JSONResponse({"ok": False, "error": "GOOGLE_CLIENT_ID is not configured on the server."}, status_code=500)
        from google.auth.transport import requests as grequests
        from google.oauth2 import id_token

        info = id_token.verify_oauth2_token(credential, grequests.Request(), GOOGLE_CLIENT_ID)
        email = str(info.get("email", "")).lower()
        if not info.get("email_verified"):
            return JSONResponse({"ok": False, "error": "Your Google email is not verified."}, status_code=403)
        domain = email.rsplit("@", 1)[-1] if "@" in email else ""
        if domain not in ALLOWED_DOMAINS:
            return JSONResponse(
                {"ok": False, "error": "Please sign in with your company account (%s)." % ", ".join("@" + d for d in ALLOWED_DOMAINS)},
                status_code=403,
            )
        request.session["email"] = email
        return {"ok": True}
    except ValueError as err:
        log.warning("Google token rejected: %s", err)
        return JSONResponse({"ok": False, "error": "Sign-in failed. Please try again."}, status_code=401)


@app.get("/auth/logout")
def auth_logout(request: Request):
    request.session.clear()
    return RedirectResponse("/login")


if APP_ENV == "dev":
    @app.get("/auth/dev")
    def auth_dev(request: Request, email: str):
        """Local testing only: sign in as any email without Google. Disabled unless APP_ENV=dev."""
        request.session["email"] = email.strip().lower()
        return RedirectResponse("/")


@app.get("/", response_class=HTMLResponse)
def index(request: Request):
    if not _current_email(request):
        return RedirectResponse("/login")
    return HTMLResponse(_read("index.html"), headers={"Cache-Control": "no-store"})


@app.post("/api/{fn}")
def api(fn: str, request: Request, body: dict = None):
    email = _current_email(request)
    if not email:
        return JSONResponse({"ok": False, "error": "Not signed in."}, status_code=401)
    entry = logic.API.get(fn)
    if not entry:
        return JSONResponse({"ok": False, "error": "Unknown function: " + fn}, status_code=404)
    func, needs_user = entry
    args = (body or {}).get("args") or []
    try:
        result = func(email, *args) if needs_user else func(*args)
        return {"ok": True, "result": jsonable_encoder(result)}
    except TypeError as err:
        log.warning("Bad arguments for %s: %s", fn, err)
        return JSONResponse({"ok": False, "error": "Bad request."}, status_code=400)
    except Exception:
        log.exception("API call failed: %s", fn)
        return JSONResponse({"ok": False, "error": "Server error. Please try again."}, status_code=500)


@app.on_event("shutdown")
def _shutdown():
    import db
    db.close_pool()
