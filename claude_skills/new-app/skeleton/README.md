# @@NAME@@

Full-stack application: **Flask + PostgreSQL + React (Vite) + Docker Compose**.
Scaffolded from the minimal-core starter — a health check, a database connection,
and one example resource (`items`) end-to-end. Grow it into your own domain.

## Stack
- **Backend:** Flask 3 (gunicorn) in `backend/app.py`, PostgreSQL 16.
- **Frontend:** React 18 + Vite + Tailwind, served by nginx in production.
- **Orchestration:** `docker-compose.yml` (postgres + backend + frontend).

## Quick start
```bash
cp .env.example .env                     # done by the scaffolder
cp frontend/.env.example frontend/.env   # done by the scaffolder
docker compose up -d --build
curl http://localhost:5100/api/health    # {"status":"healthy","database":"connected"}
```
Open the app at http://localhost:3100 and add an item.

See [SETUP.md](SETUP.md) for configuration, ports, and the migration workflow.

## Make it your own
- **Schema:** edit `database/sql_init.sql` and mirror changes into the `_SCHEMA_SQL`
  block in `backend/app.py` (see the `db-migrations` skill).
- **API:** add routes in `backend/app.py` (see the `backend-conventions` skill).
- **UI:** add pages in `frontend/src/pages` and calls in `frontend/src/api.js`
  (see the `frontend-conventions` skill).
- **Optional add-ons** (auth, AI, file uploads, backups) are not included by
  default — add them per app when needed.
