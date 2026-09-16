---
name: new-app
description: Scaffold a new full-stack app (Flask + React + PostgreSQL + Docker Compose) from the bundled starter. Use when I say "scaffold a new app", "start a new app", "create a new project", or "spin up a new app called X".
argument-hint: <app_name> <target_dir> [--display "Display Name"]
disable-model-invocation: true
allowed-tools: Bash(${CLAUDE_SKILL_DIR}/scripts/scaffold.sh *)
---

# new-app — scaffold a new full-stack app

Creates a new application from the **bundled minimal-core skeleton** that ships
inside this skill (`${CLAUDE_SKILL_DIR}/skeleton`) — Flask + PostgreSQL + React
(Vite) + Docker Compose, with a health check, a database connection, and one
example resource (`items`) wired end-to-end. There is **no external template
repo**; the skeleton is self-contained and is the source of truth. The scaffolded
app is a working starter that you then grow into its own domain.

## Standing rules

- **Always run the bundled script — never hand-create the files.** It copies the
  skeleton and substitutes the app name; it does not regenerate anything:

  ```bash
  ${CLAUDE_SKILL_DIR}/scripts/scaffold.sh $ARGUMENTS
  ```

  `$0` is the app name, `$1` is the target directory.

- **Required arguments:** `<app_name>` and `<target_dir>`. If either is missing,
  ask — don't guess. `app_name` may be `snake_case`, `hyphen-case`, or
  `"Display Style"`; the script normalises it and derives the env prefix, slug and
  display name (see [references/naming.md](references/naming.md)).

- **Optional:** `--display "Human Name"` overrides the UI/title display name
  (default: title-cased app name).

- **Never overwrite an existing app.** The script refuses a non-empty target and
  fails loudly on missing prerequisites. Don't delete the target to work around it —
  pick a new one or confirm with me.

- **After scaffolding, verify the stack comes up** and report the health result
  (see below).

- **Do not commit the new repo for me** beyond the single initial commit the script
  makes.

## Minimal core — what's in, what's not

**In:** compose (postgres + backend + frontend), Dockerfiles + `.dockerignore`,
`/api/health`, a DB connection, the idempotent `_SCHEMA_SQL` migration hook, one
`items` table + CRUD routes + one React page + `api.js`, ESLint config, `.env`
examples, `README.md` + `SETUP.md`.

**Not in (add per app when needed):** authentication (Entra/MSAL), AI/Ollama, web
search, file uploads, backup tooling. Keep new apps minimal; introduce these only
when a given app calls for them.

## Verify the stack comes up

```bash
cd <target_dir>
docker compose up -d --build
docker compose ps                              # postgres should be "healthy"
curl -s http://localhost:5100/api/health       # {"status":"healthy","database":"connected"}
curl -s http://localhost:5100/api/items        # []
```

Default host ports are 3100 (frontend), 5100 (backend), 5439 (postgres); change
them in `.env` if they clash. Full procedure (waiting, smoke checks, teardown, and
the sandbox-DNS build workaround) is in [references/verify.md](references/verify.md).

## Growing the app

The scaffold is a working starter. Build the real domain following the companion
skills: **db-migrations** (add tables), **backend-conventions** (add API routes),
**frontend-conventions** (add pages + api calls).
