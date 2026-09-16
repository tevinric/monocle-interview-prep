"""
Database access — psycopg2 with RealDictCursor (rows are dicts), parameterised SQL only.

`get_db_connection()` lives here rather than in app.py so that the agent, ingest, seed
and eval modules share it without importing the Flask app.
"""
from contextlib import contextmanager

import psycopg2
from psycopg2.extras import RealDictCursor

from lens.config import get_settings


def get_db_connection():
    s = get_settings()
    return psycopg2.connect(
        host=s.db_host,
        port=s.db_port,
        database=s.db_name,
        user=s.db_user,
        password=s.db_password,
        cursor_factory=RealDictCursor,
        connect_timeout=5,
    )


@contextmanager
def db_cursor(commit=False):
    """One connection per unit of work: commit on success, roll back on error, always close."""
    conn = get_db_connection()
    cur = conn.cursor()
    try:
        yield cur
        if commit:
            conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()
        conn.close()


def vector_literal(values):
    """pgvector text form. Bound as a parameter and cast in SQL: CAST(%s AS vector(1536))."""
    return '[' + ','.join(format(float(v), '.7g') for v in values) + ']'
