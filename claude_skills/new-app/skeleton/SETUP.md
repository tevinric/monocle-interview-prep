# @@NAME@@ — Setup

## 1. Prerequisites
- Docker + Docker Compose.

## 2. Environment
Two env files (both pre-created by the scaffolder from their `.example`):
- `.env` — backend + compose. Set a strong `@@PREFIX@@_DB_PASSWORD` before real use.
- `frontend/.env` — Vite build-time vars (`VITE_@@PREFIX@@_API_URL`).

### Host ports (change if they clash with another stack)
| Var | Default | Service |
|-----|---------|---------|
| `@@PREFIX@@_FRONTEND_PORT` | 3100 | frontend (nginx) |
| `@@PREFIX@@_BACKEND_PORT`  | 5100 | backend API |
| `@@PREFIX@@_DB_PORT_HOST`  | 5439 | postgres |

The backend listens on port `5000` inside the compose network; only the host-side
ports above are configurable.

## 3. Run
```bash
docker compose up -d --build
docker compose ps                          # postgres should be "healthy"
curl http://localhost:5100/api/health      # {"status":"healthy","database":"connected"}
curl http://localhost:5100/api/items       # []
```

## 4. Database schema
- Fresh volumes apply `database/sql_init.sql` automatically.
- To add a table/column: edit `sql_init.sql` **and** mirror idempotent DDL into the
  `_SCHEMA_SQL` block in `backend/app.py`, then `docker compose restart backend`.
  See the `db-migrations` skill.

## 5. Local development (without Docker)
```bash
# backend
cd backend && pip install -r requirements.txt && python app.py   # :5000
# frontend
cd frontend && npm install && npm run dev                         # :3000, proxies /api
```

## 6. Tear down
```bash
docker compose down          # stop, keep data
docker compose down -v       # also drop the postgres volume (destroys data)
```
