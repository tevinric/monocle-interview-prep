# Lens — Setup

## 1. Prerequisites

- Docker and Docker Compose.
- An **OpenAI API key** (platform.openai.com → API keys) with credit on the account.
- An **Azure Key Vault** and a service principal that can read this app's secrets. The
  vault holds the credentials; it is not used for models.

## 2. Create the vault secrets

One vault and one service principal per app: it is the only design where a leaked client
secret has a blast radius of exactly one application.

```bash
VAULT=<your-vault-name>

az keyvault secret set --vault-name "$VAULT" --name LENS-DB-NAME       --value 'lens_db'
az keyvault secret set --vault-name "$VAULT" --name LENS-DB-USER       --value 'lens_user'
az keyvault secret set --vault-name "$VAULT" --name LENS-DB-PASSWORD   --value "$(openssl rand -base64 24)"
az keyvault secret set --vault-name "$VAULT" --name LENS-OPENAI-API-KEY --value 'sk-...'
```

No Azure CLI? Create the same four in the portal: vault → **Objects → Secrets →
Generate/Import**. Names must match exactly.

Create the principal and grant it `get` on secrets — nothing more:

```bash
az ad sp create-for-rbac --name "sp-lens-keyvault"
VAULT_ID=$(az keyvault show --name "$VAULT" --query id -o tsv)

# Per-secret scoping (required if the vault is shared with other apps; the name prefix
# is a convention, not a permission boundary):
for SECRET in $(az keyvault secret list --vault-name "$VAULT" \
                  --query "[?starts_with(name,'LENS-')].name" -o tsv); do
  az role assignment create --role "Key Vault Secrets User" \
    --assignee <appId> --scope "$VAULT_ID/secrets/$SECRET"
done
```

`fetch_secrets.py` reads secrets **by exact name and never lists the vault**, which is what
makes per-secret scoping possible. Do not add a `list_properties_of_secrets()` call.

> The database credentials only take effect when the `lens_pg_data` volume is first
> created. If the volume already exists, the vault values must match the role inside it.
> Change a live password with `ALTER ROLE lens_user WITH PASSWORD '<new>';` and then update
> the vault — never the vault alone.

## 3. Start the stack

```bash
cp lens_kv_init.sh.example lens_kv_init.sh     # gitignored
$EDITOR lens_kv_init.sh                        # four values from step 2
source ./lens_kv_init.sh
make up                                        # docker compose up --build -d

docker compose ps                              # postgres healthy, keyvault_init exited 0
curl -s http://localhost:5100/api/health       # {"status":"healthy","database":"connected"}
```

These four variables are the only ones that must exist in your shell:

| Variable | Value |
|---|---|
| `LENS_AZURE_KEYVAULT_URL` | `https://<vault>.vault.azure.net/` |
| `LENS_AZURE_TENANT_ID` | Directory (tenant) ID |
| `LENS_AZURE_CLIENT_ID` | Application (client) ID of the principal |
| `LENS_AZURE_CLIENT_SECRET` | The principal's client secret |

They are prefixed on purpose: several apps' init scripts may be sourced into one shell, and
unprefixed names would leave one app authenticating as another's principal.

### Host ports

| Variable | Default | Service |
|---|---|---|
| `LENS_FRONTEND_PORT` | 3100 | frontend (nginx) |
| `LENS_BACKEND_PORT` | 5100 | backend API |
| `LENS_DB_PORT_HOST` | 5439 | PostgreSQL |

Set them in `.env` if they clash. Container, volume and network names are already unique
to this app (`lens_*`) — do not make them generic; this Docker host runs other applications
and those names are global to the daemon.

## 4. Check the models

```bash
make check-model
```

Calls the chat model, the judge model and the embedding model with the exact parameters
Lens sends, and prints what came back. Run it before `make ingest` — a wrong model name or
an unsupported parameter fails here in seconds instead of halfway through ingest.

Defaults are `gpt-5.6-luna` (agent), `gpt-5-nano` (judge) and `text-embedding-3-small`.
To change them, set `LENS_CHAT_MODEL`, `LENS_JUDGE_MODEL` or `LENS_EMBEDDING_MODEL` in
`.env`, then `docker compose up -d --force-recreate backend`.

Two constraints worth knowing:

- Reasoning models (`gpt-5*`, `gpt-6*`, `o*`) take `max_completion_tokens` and
  `reasoning_effort` and **reject `temperature`**; older models are the opposite. The
  backend picks the right shape per model, and records what it sent on the span.
- `LENS_REASONING_EFFORT` accepts `none`, `low`, `medium`, `high`, `xhigh`. `minimal` and
  `max` were withdrawn from the API; the backend rejects them at startup rather than
  failing on the first question.
- On a reasoning model `LENS_LLM_MAX_TOKENS` covers reasoning **and** the visible answer.
  It defaults to 8000 there (2000 on a standard model). Set it too low and answers are
  truncated with `finish_reason=length`.
- Changing `LENS_EMBEDDING_MODEL` to one with different dimensions also means changing
  `vector(1536)` in `database/sql_init.sql` **and** the `_SCHEMA_SQL` block in
  `backend/app.py`, then re-ingesting. The app refuses to start if they disagree.

## 5. Build the corpus

```bash
make ingest                                              # all six documents, ~2–3 min
docker compose exec backend /app/entrypoint.sh python -m lens.ingest.cli --doc euaiact --show-sections
docker compose exec backend /app/entrypoint.sh python -m lens.ingest.cli --query "independent model validation"
```

`docker compose exec` starts a process without the image's ENTRYPOINT, which is what loads
the Key Vault credentials — so run one-off commands through `/app/entrypoint.sh`, as the
Makefile targets do.

`make ingest` downloads each source to `corpus/raw/`, records its SHA-256, parses it into
sections, chunks and embeds it, then rebuilds the ivfflat index. Re-running skips documents
whose SHA-256 has not changed. A download failure marks the document `unavailable` —
visible in `/corpus`, and the agent is told it cannot search it.

Useful flags: `--offline` (use the copies already in `corpus/raw`), `--no-embed` (parse and
store without calling OpenAI), `--force` (re-parse regardless of hash).

Embedding the whole corpus is about 300k tokens — roughly **$0.006** at
`text-embedding-3-small` prices.

## 6. Demo mode

```bash
make record        # once, online: captures model responses for the demo questions
make seed          # populate the audit history
```

Then either set `LENS_DEMO_MODE=true` in `.env` and `make up`, or:

```bash
make up-offline    # skips keyvault-init, reuses the secrets volume, demo mode on
```

`make up-offline` refuses if the `lens_secrets` volume was never populated — bring the
stack up online at least once first.

## 7. Evaluation

```bash
make eval                                                     # 25 questions, pass/fail table
docker compose exec backend /app/entrypoint.sh python -m lens.evals.run --only ss123_validation
```

Results are written to the `evals` table and shown at `/evals`, each row linking to its
trace.

## 8. Database schema changes

There is no migration framework; the schema lives in two places and a change touches both:

1. `database/sql_init.sql` — applied once by the Postgres entrypoint on a fresh volume.
2. `_SCHEMA_SQL` in `backend/app.py` — idempotent DDL applied by `_ensure_schema()`, which
   is how a running database picks up new tables and columns.

Use `CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, and
`DROP TRIGGER IF EXISTS` before `CREATE TRIGGER`. Apply with `docker compose restart backend`
and verify with `make psql` then `\d <table>`.

## 9. Local development without Docker

```bash
cd backend && pip install -r requirements.txt
export LENS_DB_HOST=localhost LENS_DB_PORT=5439 LENS_DB_NAME=... LENS_DB_USER=... LENS_DB_PASSWORD=...
export LENS_OPENAI_API_KEY=sk-...
python app.py                       # :5000

cd frontend && npm install && npm run dev    # :3000, proxies /api to VITE_LENS_API_URL
```

## 10. Teardown

```bash
make down                      # stop, keep data
docker compose down -v         # also drops lens_pg_data AND lens_secrets — destroys data
```

Never prune volumes or images on this host to clean up: other applications share the
daemon.

## 11. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `required variable LENS_AZURE_KEYVAULT_URL is missing a value` | You did not `source ./lens_kv_init.sh` in this shell |
| `dependency failed to start: container lens_keyvault_init exited (1)` | `docker compose logs keyvault-init` — a missing secret or an RBAC denial names itself |
| `[backend] ERROR: /secrets/backend.env not found` | keyvault-init never completed |
| Backend exits with `Lens cannot start — <VAR> is not set` | A required secret or setting is missing; the message names it and where it comes from |
| `make check-model` fails with `model_not_found` | The model name is wrong or not enabled on your account — set `LENS_CHAT_MODEL` in `.env` |
| `make check-model` fails naming `temperature` or `max_tokens` | That model family wants the other parameter shape; report it — the backend's family detection needs the model prefix adding |
| `unsupported_value` naming `reasoning_effort` | The model does not accept that effort. Use `none`, `low`, `medium`, `high` or `xhigh` in `LENS_REASONING_EFFORT` |
| `Model output was truncated (finish_reason=length)` | Raise `LENS_LLM_MAX_TOKENS` above the figure the error reports, or lower `LENS_REASONING_EFFORT` so less of the budget goes on reasoning |
| `insufficient_quota` / `429` | No credit on the OpenAI account, or rate limited; the backend retries once, then fails the span |
| Backend up, `/api/health` unhealthy | Vault DB credentials do not match the role inside the existing `lens_pg_data` volume |
| Answers always abstain | The corpus is not ingested, or it failed — check `/corpus` |
| `Demo mode has no recording for this question` | Run `make record` online first, or ask one of the recorded questions |

## Security posture

The `lens_secrets` volume holds **plaintext** credential files on the Docker host. This
design means no credential sits in git, in an image, or in `docker inspect` on a
long-lived service, and an application compromise cannot reach the vault, because only
`keyvault-init` ever holds vault credentials and it has already exited. It is **not** a
defence against host compromise: root, or any member of the `docker` group, can read the
volume, the service principal's client secret and the OpenAI key. Encrypt the host disk,
rotate both on a schedule you will honour, and turn on Key Vault diagnostics — the audit
log is the main thing a vault gives you that shell exports never could.
