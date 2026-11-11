"""
Builds templates/index.html from the original Apps Script page (ApprovalIndex.html).

Usage:
    python make_index.py path/to/ApprovalIndex.html

What it changes (nothing else is touched):
  1. adds <script src="/static/shim.js"> so google.script.run talks to this server
  2. adds the viewport meta tag that Apps Script used to add in doGet()
  3. adds a small "Sign out" link next to the user's email in the top bar
Run it again whenever the original ApprovalIndex.html changes.
"""
import sys
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent


def main():
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else BASE_DIR / "ApprovalIndex.html"
    html = src.read_text(encoding="utf-8")

    head_add = (
        '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
        '  <title>IMS Purchase Approval Tracker</title>\n'
        '  <script src="/static/shim.js"></script>\n'
    )
    if html.count("</head>") != 1:
        raise SystemExit("Expected exactly one </head> in " + str(src))
    html = html.replace("</head>", "  " + head_add + "</head>", 1)

    marker = '<span id="userEmailLabel"></span>'
    if html.count(marker) != 1:
        raise SystemExit("Could not find the user email label in " + str(src))
    html = html.replace(
        marker,
        marker + '<a href="/auth/logout" title="Sign out" '
                 'style="margin-left:10px;font-size:12px;font-weight:600;color:#2458b6;">Sign out</a>',
        1,
    )

    out = BASE_DIR / "templates" / "index.html"
    out.parent.mkdir(exist_ok=True)
    out.write_text(html, encoding="utf-8")
    print("Wrote", out, "(%d bytes)" % len(html.encode("utf-8")))


if __name__ == "__main__":
    main()
