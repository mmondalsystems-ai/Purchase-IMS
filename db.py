"""Database connection pool (Supabase PostgreSQL)."""
import os
import threading

from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

_pool = None
_lock = threading.Lock()


def get_pool() -> ConnectionPool:
    global _pool
    if _pool is None:
        with _lock:
            if _pool is None:
                url = os.environ.get("DATABASE_URL", "").strip()
                if not url:
                    raise RuntimeError("DATABASE_URL is not set. Copy .env.example to .env and fill it in.")
                _pool = ConnectionPool(
                    url,
                    min_size=1,
                    max_size=int(os.getenv("DB_POOL_MAX", "8")),
                    max_lifetime=1800,
                    kwargs={
                        "row_factory": dict_row,
                        "autocommit": False,
                        # Required when the Supabase "Transaction pooler" (port 6543) is used.
                        "prepare_threshold": None,
                    },
                    check=ConnectionPool.check_connection,
                    open=True,
                )
                _pool.wait(timeout=30)
    return _pool


def connection():
    """Use as:  with db.connection() as conn:  - commits on success, rolls back on error."""
    return get_pool().connection()


def close_pool():
    global _pool
    if _pool is not None:
        _pool.close()
        _pool = None
