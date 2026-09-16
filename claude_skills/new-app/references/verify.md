# Verifying a scaffolded app

Standing procedure to confirm a freshly scaffolded app runs.

## 1. Pick non-conflicting host ports

Defaults: `3100` (frontend), `5100` (backend), `5439` (postgres). If another stack
uses them, edit the new app's `.env` first (`<PREFIX>` is the derived env prefix):

```bash
cd <target_dir>
sed -i 's/^<PREFIX>_FRONTEND_PORT=.*/<PREFIX>_FRONTEND_PORT=3200/' .env
sed -i 's/^<PREFIX>_BACKEND_PORT=.*/<PREFIX>_BACKEND_PORT=5200/'  .env
sed -i 's/^<PREFIX>_DB_PORT_HOST=.*/<PREFIX>_DB_PORT_HOST=5440/'  .env
```

Container/volume/network names are already unique per app; only host ports can clash.

## 2. Bring it up and check health + the example resource

```bash
docker compose up -d --build
docker compose ps                                  # postgres should be "healthy"
curl -s http://localhost:<BACKEND_PORT>/api/health # {"status":"healthy","database":"connected"}
curl -s http://localhost:<BACKEND_PORT>/api/items  # []  (empty list)
curl -s -X POST http://localhost:<BACKEND_PORT>/api/items \
  -H 'Content-Type: application/json' -d '{"name":"First","description":"hi"}'
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:<FRONTEND_PORT>/           # 200
curl -s http://localhost:<FRONTEND_PORT>/api/health                                  # proxied via nginx
```

The backend has no compose healthcheck; poll `/api/health` a few times to allow for
startup. `_ensure_schema()` creates the `items` table on the first `/api/items` call.

## 3. Smoke checks

```bash
python3 -m py_compile backend/app.py
# frontend lint (run in a container if node isn't on the host):
docker run --rm -v "$PWD/frontend":/app -w /app node:20-alpine \
  sh -c 'npm install --no-audit --no-fund --silent && npm run lint'
```

`npm run lint` gates on errors; the skeleton lints clean.

## 4. Tear down

```bash
docker compose down          # stop, keep data
docker compose down -v       # also drop the postgres volume (destroys data)
```

`node_modules` created by a root container are root-owned; remove a throwaway tree
with `docker run --rm -v /tmp:/t alpine rm -rf /t/<dir>`.

## Sandbox / restricted-network builds

If the build fails during `npm install` / `pip install` with `EAI_AGAIN` (DNS
failure), the Docker **build** network can't resolve DNS — an environment issue,
not a skeleton defect. Build against the host network with a throwaway override
(delete it after verifying):

```yaml
# docker-compose.override.yml
services:
  backend:  { build: { network: host } }
  frontend: { build: { network: host } }
```
