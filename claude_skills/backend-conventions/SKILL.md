---
name: backend-conventions
description: Conventions for this stack's Flask + PostgreSQL backend (backend/app.py). Auto-loads when editing backend files. Covers routes, DB access, env vars, error handling, and the schema hook.
paths:
  - "backend/**"
  - "**/backend/**"
---

# Backend conventions (Flask + PostgreSQL)

Standing rules for `backend/app.py` and everything under `backend/`. The backend is
a **single-file Flask app** served by gunicorn — no ORM, no blueprints. Match this
style when adding code (the scaffolded `items` routes are the reference example)
unless I ask to restructure.

## Routes
- All API routes live under `/api/...`, registered with
  `@app.route('/api/<thing>', methods=[...])` on `app`.
- Return JSON via `jsonify(...)` with an explicit status: `200` ok, `201` created,
  `400` bad input, `404` missing, `500` error.
- For an update/delete, use `... RETURNING id` and treat `cur.fetchone() is None`
  as `404`.

## Database access
- One connection per request via `get_db_connection()` (a `RealDictCursor`
  connection — **rows are dicts**, accessed by column name).
- Lifecycle in every handler: `conn = get_db_connection()` → `cur = conn.cursor()`
  → `cur.execute(sql, params)` → `conn.commit()` on writes → `cur.close()` →
  `conn.close()`.
- **Always parameterise** (`%s` + a params tuple). Never f-string user input into SQL.
- Double-quote reserved-word column names in SQL if you introduce any.
- Store structured data in `JSONB` columns; write with `json.dumps(...)`, read back
  already parsed.

## Environment variables
- Every backend var is prefixed with the app's env prefix (e.g. `ACMECRM_...`), read
  via `os.getenv('PREFIX_NAME', default)`.
- Adding a setting means editing **three** places: `os.getenv(...)`, `.env.example`,
  and the `backend` service `environment:` block in `docker-compose.yml`.

## Error handling & logging
- Wrap handler bodies in `try/except Exception as e:`, log with
  `logger.error(f"... {str(e)}")`, and return a generic `jsonify({'error': ...}), 500`
  — never leak internals to the client.
- Use the module `logger` (`logging.getLogger(__name__)`), not `print`.

## Health & schema
- `GET /api/health` checks the DB only (`SELECT 1`) and must stay dependency-free.
- New tables/columns go in `database/sql_init.sql` **and** the idempotent
  `_SCHEMA_SQL` block (applied by `_ensure_schema()`); call `_ensure_schema()` at the
  top of handlers that touch new tables. See the `db-migrations` skill.

## Optional add-ons (not in the minimal core)
- **Auth:** if the app needs it, add a `@token_required`-style decorator that sets
  `g.user_id`/`g.user_email`, place it under `@app.route`, add a `user_id UUID`
  column to owned tables, and scope every query with `AND user_id = %s`.
- **External services (AI, etc.):** read config from `PREFIX_*` env vars and set the
  gunicorn `timeout` above any long outbound call so a slow response yields a clean
  `ReadTimeout` instead of a killed worker.

Copy-paste templates: [references/patterns.md](references/patterns.md).
