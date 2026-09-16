# Verifying without disturbing the other apps

Other applications are running on this host. **Never** run `docker compose down -v`, and
never prune volumes, images or networks to test. Everything below uses throwaway names
and cleans up after itself.

## 0. Confirm the compose file parses and secrets are gone from it

```bash
source ./<slug>_kv_init.sh
docker compose config >/dev/null && echo "compose valid"

# No secret should appear in any long-lived service's environment:
docker compose config | grep -iE 'password|secret[_-]?key' || echo "no secrets in compose ✓"
```

Also check it fails closed when the shell is empty — this must error, not default:

```bash
env -u <VAULT_PREFIX>_AZURE_KEYVAULT_URL docker compose config 2>&1 | head -2
```

## 1. Test the fetcher against a stubbed vault (no Azure needed)

Build the init image standalone and drive `fetch_all` / `write_outputs` with a fake
client. This proves required/optional handling and — importantly — that a password
containing shell metacharacters survives being sourced.

```bash
docker build -t kvcheck ./keyvault
```

```python
# /tmp/kvtest.py — run inside the image
import sys, os, subprocess; sys.path.insert(0, "/app")
import fetch_secrets as fs
from azure.core.exceptions import ResourceNotFoundError

class S:
    def __init__(self, v): self.value = v
VAULT = {
    "<VAULT_PREFIX>-DB-NAME": "app_db",
    "<VAULT_PREFIX>-DB-USER": "app_user",
    "<VAULT_PREFIX>-DB-PASSWORD": "p@ss'w\"o$rd `x` ;rm -rf /",   # nasty on purpose
    "<VAULT_PREFIX>-SECRET-KEY": "k",
}
class C:
    def get_secret(self, n):
        if n not in VAULT: raise ResourceNotFoundError(n)
        return S(VAULT[n])

fs.SECRETS_DIR, fs.PARTS_DIR, fs.ENV_FILE = "/tmp/o", "/tmp/o/parts", "/tmp/o/backend.env"
(values, parts), missing = fs.fetch_all(C())
assert not missing, missing
fs.write_outputs(values, parts)

out = subprocess.run(["bash", "-c", '. /tmp/o/backend.env; printf "%s" "$<ENV_PREFIX>_DB_PASSWORD"'],
                     capture_output=True, text=True)
assert out.stdout == VAULT["<VAULT_PREFIX>-DB-PASSWORD"], repr(out.stdout)
print("quoting round-trip OK")

del VAULT["<VAULT_PREFIX>-SECRET-KEY"]
_, missing = fs.fetch_all(C())
assert missing == ["<VAULT_PREFIX>-SECRET-KEY"], missing
print("fail-closed on missing required secret OK")
```

```bash
docker run --rm --entrypoint python -v /tmp/kvtest.py:/t.py:ro kvcheck -u /t.py
```

## 2. Test postgres + backend on throwaway names

```bash
docker volume create kvcheck_secrets
# seed it with the stub above, pointing fs.SECRETS_DIR at /secrets and mounting
# -v kvcheck_secrets:/secrets

docker run -d --name kvcheck_pg \
  -e POSTGRES_DB_FILE=/secrets/parts/<VAULT_PREFIX>-DB-NAME \
  -e POSTGRES_USER_FILE=/secrets/parts/<VAULT_PREFIX>-DB-USER \
  -e POSTGRES_PASSWORD_FILE=/secrets/parts/<VAULT_PREFIX>-DB-PASSWORD \
  -v kvcheck_secrets:/secrets:ro -v kvcheck_pgdata:/var/lib/postgresql/data \
  --health-cmd='pg_isready -U "$(cat /secrets/parts/<VAULT_PREFIX>-DB-USER)" -d "$(cat /secrets/parts/<VAULT_PREFIX>-DB-NAME)"' \
  --health-interval=3s postgres:16

until [ "$(docker inspect -f '{{.State.Health.Status}}' kvcheck_pg)" = healthy ]; do sleep 1; done
docker exec kvcheck_pg psql -U <user> -d <db> -c 'select current_user, current_database();'
```

Then the backend, on its own network, against that postgres — the real proof is the
health endpoint reporting a live DB connection:

```bash
docker network create kvcheck_net
docker network connect kvcheck_net kvcheck_pg
docker build -t kvcheck_backend ./backend
docker run -d --name kvcheck_backend --network kvcheck_net \
  -e <ENV_PREFIX>_DB_HOST=kvcheck_pg -e <ENV_PREFIX>_DB_PORT=5432 \
  -v kvcheck_secrets:/secrets:ro kvcheck_backend

docker logs kvcheck_backend | head -3      # expect the "loaded secrets" line
docker run --rm --network kvcheck_net curlimages/curl -s http://kvcheck_backend:5000/api/health
```

Also confirm the entrypoint fails closed with no secrets file:

```bash
docker run --rm --entrypoint /app/entrypoint.sh kvcheck_backend true; echo "exit=$?"   # expect 1
```

## 3. Clean up — always

```bash
docker rm -f kvcheck_pg kvcheck_backend 2>/dev/null
docker network rm kvcheck_net 2>/dev/null
docker volume rm kvcheck_secrets kvcheck_pgdata 2>/dev/null
docker rmi kvcheck kvcheck_backend 2>/dev/null
docker volume ls | grep kvcheck || echo "clean"
```

## 4. Real run

```bash
source ./<slug>_kv_init.sh
docker compose up --build -d
docker compose logs keyvault-init     # one line per secret, ends with "done"
```

Confirm no secret leaked into the long-lived container configs:

```bash
docker inspect <slug>_backend --format '{{json .Config.Env}}' | tr ',' '\n' | grep -i pass \
  || echo "no secrets in backend container config ✓"
```

(`docker exec <slug>_backend env` **will** still show them — that is the process
environment, root-only, and unavoidable given the app reads `os.getenv`.)
