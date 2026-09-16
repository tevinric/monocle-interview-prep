# Migration procedure (step by step)

## 1. Define the change (canonical form) in `database/sql_init.sql`

New table, house style:

```sql
-- =============================================================================
-- THINGS TABLE
-- =============================================================================
CREATE TABLE IF NOT EXISTS things (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    payload JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
DROP TRIGGER IF EXISTS update_things_updated_at ON things;
CREATE TRIGGER update_things_updated_at
    BEFORE UPDATE ON things
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE INDEX IF NOT EXISTS idx_things_created_at ON things(created_at DESC);
```

New column instead:

```sql
ALTER TABLE things ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'open';
```

## 2. Mirror it (idempotent) into `_SCHEMA_SQL` in `backend/app.py`

Paste the **same** statements into the `_SCHEMA_SQL` string. This block upgrades
databases that already have data; it must stay 100% idempotent (it runs whenever
`_ensure_schema()` fires). The `uuid-ossp` extension and `update_updated_at_column()`
function are already set up at the top of the block — reuse them, don't redefine.

Then make sure handlers that use the new table call `_ensure_schema()` at the top
(as the `items` routes do).

## 3. Apply to a running stack

**A. Restart the backend** (reruns `_ensure_schema()` on next request):
```bash
docker compose restart backend
curl -s http://localhost:<BACKEND_PORT>/api/things   # first call triggers the migration
```

**B. Apply the DDL directly** (immediate, no restart):
```bash
docker compose exec -T postgres \
  psql -U "$<PREFIX>_DB_USER" -d "$<PREFIX>_DB_NAME" <<'SQL'
ALTER TABLE things ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'open';
SQL
```
(`<PREFIX>` is the app env prefix, e.g. `ACMECRM`; values are in `.env`.)

**C. Fresh install only** (DESTROYS ALL DATA — confirm first):
```bash
docker compose down -v && docker compose up -d --build   # re-runs sql_init.sql
```

## 4. Verify

```bash
docker compose exec postgres \
  psql -U "$<PREFIX>_DB_USER" -d "$<PREFIX>_DB_NAME" -c '\d things'
```

## Checklist
- [ ] Canonical DDL in `sql_init.sql`.
- [ ] Idempotent DDL mirrored in `_SCHEMA_SQL` (`backend/app.py`).
- [ ] All statements use `IF NOT EXISTS` / `DROP ... IF EXISTS`.
- [ ] Followed UUID PK + `updated_at` trigger + `idx_` conventions.
- [ ] Handlers using the new table call `_ensure_schema()`.
- [ ] Applied (restart or direct DDL) and verified with `\d`.
- [ ] No destructive step without explicit sign-off.
