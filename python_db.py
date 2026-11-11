import os
from urllib.parse import urlsplit, unquote

import psycopg
from dotenv import load_dotenv

# override=True: the .env file wins over any DATABASE_URL already set in the terminal
load_dotenv(override=True)

url = os.getenv("DATABASE_URL", "").strip()
p = urlsplit(url)
user = unquote(p.username or "")
pwd = unquote(p.password or "")
host = p.hostname
db = (p.path or "/").lstrip("/") or "postgres"

print("user     :", user)
print("host     :", host)
print("port     :", p.port)
print("database :", db)
print("password length:", len(pwd), "| non-alphanumeric characters:", sum(not c.isalnum() for c in pwd))
print("password has space or quote:", any(c in pwd for c in " \"'"))

for port in (6543, 5432):
    try:
        with psycopg.connect(host=host, port=port, user=user, password=pwd, dbname=db,
                             connect_timeout=15, prepare_threshold=None) as conn:
            name = conn.execute("select current_database()").fetchone()[0]
            print("port %s: CONNECTED to %s" % (port, name))
    except Exception as exc:
        print("port %s: FAILED -> %s" % (port, str(exc).splitlines()[0]))