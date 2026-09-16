---
name: db-migrations
description: The exact procedure for adding and applying a database schema change in this stack (PostgreSQL). Use when I say "add a table", "add a column", "change the schema", or "apply a migration".
argument-hint: [short description of the schema change]
disable-model-invocation: true
---

# db-migrations — add and apply a schema change

This stack has **no migration framework**. Schema lives in two places, and a correct
change touches **both** so it works on fresh *and* already-running databases:

1. **`database/sql_init.sql`** — the full schema. Postgres runs it **once**, only
   when the data volume is empty (fresh install). Editing it does nothing to an
   existing database.
2. **`_SCHEMA_SQL`** in `backend/app.py` — an idempotent DDL block run by
   `_ensure_schema()` (called at the top of handlers that touch newer tables). This
   is how running databases pick up new tables/columns.

## Standing rules

- **Every schema change goes in BOTH places** — the canonical definition in
  `sql_init.sql`, and an idempotent form in `_SCHEMA_SQL`. Never edit only one.
- **Idempotent DDL only:** `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`,
  `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, `DROP TRIGGER IF EXISTS` before
  `CREATE TRIGGER`.
- **Follow the house conventions** (see [references/procedure.md](references/procedure.md)):
  `UUID PRIMARY KEY DEFAULT uuid_generate_v4()`, `created_at`/`updated_at TIMESTAMP
  DEFAULT CURRENT_TIMESTAMP`, the shared `update_updated_at_column()` trigger, and
  `idx_<table>_<col>` indexes. The scaffolded `items` table is the reference.
- **Any handler that reads/writes a newly added table must call `_ensure_schema()`**
  at the top (as the `items` routes do) so the table exists on first use.
- **Never write a destructive migration** (DROP/rename a column, DELETE data) without
  confirming with me first — the two blocks are additive by design.
- **Apply** to a running stack by restarting the backend (reruns `_ensure_schema()`)
  or by executing the DDL directly; a fresh `down -v` re-applies `sql_init.sql` **and
  destroys all data** — only when I ask.
- **Verify** afterwards with `\d <table>`.

Full step-by-step with copy-paste SQL and commands:
[references/procedure.md](references/procedure.md).
