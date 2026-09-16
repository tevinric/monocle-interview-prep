<!-- =========================================================================
     Paste into the app's README.md and fill in the tables from SECRET_MAP.
     Keep the two tables in sync with keyvault/fetch_secrets.py — that file is
     the source of truth for what the vault must contain.
     ====================================================================== -->

## Secrets and configuration

Application secrets are **not** kept in the shell, in `.env` files, or in the images.
They live in **Azure Key Vault** and are fetched at stack startup by an init container.

```
   Your shell                keyvault-init                @@SLUG@@_secrets volume
   ─────────────             ─────────────────            ────────────────────────
   4 x @@VAULT_PREFIX@@_AZURE_*  ──▶  Azure Key Vault  ──▶  /secrets/backend.env
   (service principal)             reads @@VAULT_PREFIX@@-*  /secrets/parts/...
                                   exits 0                          │
                                                        ┌───────────┴──────────┐
                                                        ▼                      ▼
                                                   postgres                backend
                                               (POSTGRES_*_FILE)    (entrypoint sources it)
```

`keyvault-init` runs first and to completion; postgres and backend both declare
`depends_on: { keyvault-init: { condition: service_completed_successfully } }`, so a
missing secret or an unreachable vault aborts the whole stack with an explicit error
rather than starting with defaults.

### What you export in your shell

The only four variables that must exist on the docker host. They unlock the vault, so
they are the one thing that cannot live inside it.

| Variable | Value |
|---|---|
| `@@VAULT_PREFIX@@_AZURE_KEYVAULT_URL` | `https://<vault-name>.vault.azure.net/` |
| `@@VAULT_PREFIX@@_AZURE_TENANT_ID` | Directory (tenant) ID of the service principal |
| `@@VAULT_PREFIX@@_AZURE_CLIENT_ID` | Application (client) ID of the service principal |
| `@@VAULT_PREFIX@@_AZURE_CLIENT_SECRET` | The service principal's client secret |

```bash
cp @@SLUG@@_kv_init.sh.example @@SLUG@@_kv_init.sh   # gitignored
$EDITOR @@SLUG@@_kv_init.sh
source ./@@SLUG@@_kv_init.sh
docker compose up --build -d
```

### Secrets to create in the Key Vault

Every secret for this app is prefixed **`@@VAULT_PREFIX@@-`**. Key Vault names allow only
letters, digits and hyphens, hence `@@VAULT_PREFIX@@-DB-NAME` rather than an underscore
form. Each maps to the environment variable the application code reads.

#### Required — the stack will not start without these

| Key Vault secret | Maps to env var | What it is |
|---|---|---|
| `@@VAULT_PREFIX@@-DB-NAME` | `@@ENV_PREFIX@@_DB_NAME` | Postgres database name |
| `@@VAULT_PREFIX@@-DB-USER` | `@@ENV_PREFIX@@_DB_USER` | Postgres role name |
| `@@VAULT_PREFIX@@-DB-PASSWORD` | `@@ENV_PREFIX@@_DB_PASSWORD` | Postgres role password |
| `@@VAULT_PREFIX@@-SECRET-KEY` | `@@ENV_PREFIX@@_SECRET_KEY` | Flask `SECRET_KEY` — long random string |

#### Optional — omit to accept the default

| Key Vault secret | Maps to env var | Default | What it does |
|---|---|---|---|
| `@@VAULT_PREFIX@@-FLASK-ENV` | `@@ENV_PREFIX@@_FLASK_ENV` | `production` | `development` enables Flask debug |

An optional secret that exists but holds an **empty value** is treated as unset and falls
back to its default.

#### Not in the vault

Non-secret topology with defaults in `docker-compose.yml` — override by exporting them
or via a `.env` file: host-side ports. The frontend's `VITE_*` values are compiled into
the JavaScript bundle and are public by construction; they stay in `frontend/.env`.

> **Database credentials only apply when the postgres data volume is first created.** If
> the volume already exists, the vault values must match the role already inside it. To
> change the password later: `ALTER ROLE <user> WITH PASSWORD '<new>';` then update the
> vault to match.

### Rotating a secret

```bash
az keyvault secret set --vault-name "$VAULT" --name @@VAULT_PREFIX@@-SECRET-KEY --value "$(openssl rand -base64 48)"
source ./@@SLUG@@_kv_init.sh
docker compose up -d --force-recreate keyvault-init backend
```

### Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `required variable @@VAULT_PREFIX@@_AZURE_KEYVAULT_URL is missing a value` | You did not `source ./@@SLUG@@_kv_init.sh` in this shell |
| `ERROR: the following REQUIRED secrets are missing` | Create the named secrets in the vault |
| `could not read '<name>' ... Forbidden` | The principal lacks a `get` grant covering that secret |
| `AADSTS7000215: Invalid client secret` | Client secret wrong or expired — issue a new one in Entra |
| `dependency failed to start: container @@SLUG@@_keyvault_init exited (1)` | `docker compose logs keyvault-init` for the real error |
| `[backend] ERROR: /secrets/backend.env not found` | keyvault-init never completed; check its logs |
| Backend up but cannot reach the DB | Vault DB credentials don't match the role in the existing data volume |
