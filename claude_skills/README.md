# claude_skills

Reusable Claude Code skills for building and maintaining apps on the
**Flask + React + PostgreSQL + Docker Compose** stack. The skills are
**self-contained** — there is no external template repo. `new-app` ships its own
minimal-core starter and stamps out new apps from it; the other skills guide how to
grow and maintain them. Add more skills here over time.

## The skills

| Skill | Invoke it when… | Type |
|-------|-----------------|------|
| **new-app** | You want to start a brand-new app: *"scaffold a new app called X in `<dir>`"*. Copies the bundled minimal-core skeleton, renames it to your app, writes `.env` files, inits a fresh git repo, then you verify the stack comes up. | Explicit only (`disable-model-invocation`) |
| **backend-conventions** | You're editing `backend/` (Flask/`app.py`). Auto-loads; enforces the route / DB-access / parameterised-SQL / env-var / error-handling patterns. | Auto (path-scoped `backend/**`) |
| **frontend-conventions** | You're editing `frontend/` (React/Vite). Auto-loads; enforces the `pages`/`components` layout, the `api.js` data layer, `VITE_` env rules, and Tailwind styling. | Auto (path-scoped `frontend/**`) |
| **db-migrations** | You're changing the database — *"add a table/column"*, *"apply a migration"*. Gives the exact two-place procedure (`sql_init.sql` **and** the idempotent `_SCHEMA_SQL` block) and how to apply/verify. | Explicit only (`disable-model-invocation`) |
| **keyvault-auth** | You want an app's secrets in Azure Key Vault instead of exported into the shell — *"add key vault"*, *"move secrets to key vault"*, *"set up app authentication"*. Scaffolds the `keyvault-init` container, the backend entrypoint and the compose snippet, and collision-checks the shared Docker host first. | Explicit only (`disable-model-invocation`) |

The two convention skills load automatically when you open a matching file. The two
side-effecting skills (`new-app`, `db-migrations`) run only when you ask for them.

## What a new app starts as (minimal core)

Flask + PostgreSQL + React + Docker Compose, a `/api/health` check, a DB connection,
the idempotent schema hook, and **one** example resource (`items`) wired end-to-end
(table + CRUD routes + one React page). **Not** included by default — auth, AI,
file uploads, backups — add these per app when needed. Secrets management is added by
**keyvault-auth**, not baked into the skeleton.

## Shared host

These apps all run on one Docker daemon, where volume, container and network names are
**global** — Compose does not namespace them by project. Every skill here names things
`<slug>_*`; a generic name lets one app silently overwrite another's state. `keyvault-auth`
checks the live daemon before writing, because a secrets-volume collision makes an app
boot with another app's credentials and raises no error.

## Layout

```
claude_skills/
  new-app/
    SKILL.md               # scaffold instructions (runs scripts/scaffold.sh)
    scripts/scaffold.sh    # copies skeleton/ + substitutes the app name
    skeleton/              # the self-contained minimal-core starter (source of truth)
      docker-compose.yml, backend/, frontend/, database/, README.md, SETUP.md
    references/{naming,verify}.md
  backend-conventions/   SKILL.md + references/patterns.md
  frontend-conventions/  SKILL.md + references/patterns.md
  db-migrations/         SKILL.md + references/procedure.md
  keyvault-auth/
    SKILL.md                       # the standing rules + the procedure
    scripts/add_keyvault_auth.sh   # collision-checks the host, then generates
    templates/                     # fetch_secrets.py, entrypoint.sh, compose snippet, README
    references/{naming,vault-setup,security,verify}.md
```

Each `SKILL.md` is kept short; long detail lives in that skill's `references/*.md`.

## Using the scaffolder directly

```bash
new-app/scripts/scaffold.sh <app_name> <target_dir> [--display "Display Name"]
```

`app_name` may be `snake_case`, `hyphen-case`, or `"Display Style"`; the env prefix,
slug and display name are derived automatically. It refuses to overwrite a non-empty
target and fails loudly on missing tools. Default host ports: 3100 (frontend), 5100
(backend), 5439 (postgres) — change them in the new app's `.env` if they clash.

## Activating these skills in Claude Code

These skills live here (not installed globally). To let Claude Code discover them,
point your skills path at this folder or symlink each one into `~/.claude/skills/`:

```bash
for s in new-app backend-conventions frontend-conventions db-migrations keyvault-auth; do
  ln -s "$PWD/$s" "$HOME/.claude/skills/$s"
done
```

`${CLAUDE_SKILL_DIR}` inside `new-app` resolves to the skill's own directory, so both
`scripts/scaffold.sh` and `skeleton/` are found regardless of where it's linked from.
