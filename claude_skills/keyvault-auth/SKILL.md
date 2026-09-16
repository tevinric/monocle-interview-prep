---
name: keyvault-auth
description: Wire an app's secrets to Azure Key Vault so nothing but four service-principal variables lives in the shell. A keyvault-init container fetches the app's PREFIX-* secrets at startup and hands them to postgres and the backend. Use when I say "add key vault", "move secrets to key vault", "set up app authentication", "stop exporting secrets", or "secure this app's secrets".
argument-hint: <app_dir> <VAULT_PREFIX>
disable-model-invocation: true
---

# keyvault-auth — Azure Key Vault secrets for an app

Replaces "export every secret into the shell before `docker compose up`" with an
**init container** that authenticates to Azure Key Vault and fetches the app's secrets
at startup. Afterwards the operator exports exactly **four** variables — the service
principal that unlocks the vault — and nothing else.

```
  shell (4 vars)  ──▶  keyvault-init  ──▶  Azure Key Vault
                            │               reads <VAULT_PREFIX>-* by exact name
                            ▼
                   <slug>_secrets volume
                    ├── backend.env            ──▶ backend (entrypoint sources it)
                    └── parts/<SECRET-NAME>    ──▶ postgres (POSTGRES_*_FILE)
```

## ⚠️ These apps share one host — read this first

Every Docker identifier here is **global to the daemon**, not scoped to the Compose
project. A generic name silently cross-wires two apps: app B's `keyvault-init`
overwrites app A's `backend.env`, and app A boots with app B's database password and
session-signing key. **No error is raised.**

**Every one of these five MUST carry the app slug or vault prefix. Never generic:**

| Thing | Pattern | Example |
|---|---|---|
| Secrets volume | `<slug>_secrets` | `kts_hr_secrets` |
| Init container | `<slug>_keyvault_init` | `kts_hr_app_keyvault_init` |
| Network | `<slug>_network` | `kts_hr_network` |
| Vault secret names | `<VAULT_PREFIX>-<NAME>` | `KTSAPP-DB-PASSWORD` |
| Bootstrap env vars | `<VAULT_PREFIX>_AZURE_*` | `KTSAPP_AZURE_CLIENT_ID` |

The bootstrap variables matter as much as the volume: the operator may `source` several
apps' init scripts into one shell, and unprefixed `AZURE_CLIENT_ID` would leave one app
authenticating as another app's principal.

`scripts/add_keyvault_auth.sh` checks all of these against the **live Docker daemon**
before writing anything, and refuses to proceed on a clash.

## Standing rules

- **One service principal per app.** Never share one across apps on this host.
- **Prefer one vault per app.** If a vault is shared, the name prefix is a *convention,
  not a permission boundary* — you must additionally scope RBAC per secret. See
  [references/vault-setup.md](references/vault-setup.md).
- **Fetch by exact name only — never `list`.** `SECRET_MAP` in `fetch_secrets.py` is the
  complete inventory and the fetcher only calls `get_secret(name)`. This is deliberate:
  it is what allows the service principal to be scoped to individual secrets rather than
  the whole vault. Adding a `list_properties_of_secrets()` call breaks that and forces a
  vault-wide grant.
- **Fail closed.** Required secrets have no default; a missing one exits non-zero, and
  `depends_on: { condition: service_completed_successfully }` stops the whole stack.
  Never give a credential a fallback default.
- **No secret in a long-lived service's `environment:` block.** Only non-secret topology
  (hostnames, container-internal ports, upload paths) goes there, so `docker inspect`
  stays clean. Credentials arrive via the volume.
- **Mount the secrets volume `:ro` everywhere except `keyvault-init`.**
- **Never mount another app's secrets volume.** Container isolation is the only thing
  separating co-tenant apps on this host.
- **Only `keyvault-init` gets vault credentials.** The backend must never hold them — it
  is the internet-facing process, and this is what stops an RCE from pivoting to the
  vault. Do not "simplify" by fetching secrets inside `app.py`.
- **`<slug>_kv_init.sh` is gitignored, always.** Commit only the `.example`.
- **Exclude the secrets volume from backups.** Check the app's backup compose.
- **`VITE_*` frontend values are never vault material** — they are compiled into the JS
  bundle and shipped to every browser. They stay in `frontend/.env`.

## Procedure

1. **Derive the names.** From the app directory: `<slug>` (the Compose project /
   container prefix already in use) and `<ENV_PREFIX>` (the app's existing
   `<PREFIX>_DB_HOST`-style variable prefix). Ask me for the `<VAULT_PREFIX>` if it is
   not obvious — it must be `[A-Z][A-Z0-9]*`, no hyphens or underscores, because it
   prefixes both Key Vault secret names *and* shell variables.
   Read [references/naming.md](references/naming.md).

2. **Inventory the secrets.** Grep the app for `getenv`/`environ` and read its compose
   `environment:` blocks. Sort every value into: a **required** secret (credential, no
   safe default), an **optional** tunable (has a sensible default), or **non-secret
   topology** (stays in compose). Show me the classification before writing anything.

3. **Run the scaffolder** — it collision-checks the live daemon, then writes
   `keyvault/`, `backend/entrypoint.sh`, `<slug>_kv_init.sh.example`, and a compose
   snippet:

   ```bash
   ${CLAUDE_SKILL_DIR}/scripts/add_keyvault_auth.sh <app_dir> <VAULT_PREFIX> <ENV_PREFIX> <slug>
   ```

4. **Populate `SECRET_MAP`** in the generated `keyvault/fetch_secrets.py` with the
   inventory from step 2. The starter map covers only DB + Flask `SECRET_KEY`.

5. **Merge the compose snippet** (`keyvault/compose-snippet.yml`) into the app's
   `docker-compose.yml` by hand — add the `keyvault-init` service, switch postgres to
   `POSTGRES_*_FILE`, add both `depends_on` conditions, strip every secret out of the
   backend `environment:`, and add the `<slug>_secrets` volume. Do not automate this
   edit; every app's compose differs.

6. **Point the backend Dockerfile at the entrypoint** — `RUN chmod +x /app/entrypoint.sh`,
   `ENTRYPOINT ["/app/entrypoint.sh"]`, keeping the existing `CMD`.

7. **Create the vault secrets and grant the principal.** Commands in
   [references/vault-setup.md](references/vault-setup.md).

8. **Verify without disturbing anything else on the host.** Follow
   [references/verify.md](references/verify.md) — it uses throwaway names and cleans up.
   Other apps are running; never `docker compose down -v` to test.

9. **Write the app's README section** from `templates/README-section.md`, listing every
   secret with its mapped variable and default.

## Migrating an app that already exports secrets

Same procedure, plus: the database credentials in the vault **must match the role
already inside the existing data volume** — `POSTGRES_*` only apply on first
initialisation. Copy the live values from the old `env_init.sh` into the vault verbatim;
change them later with `ALTER ROLE`, never by editing the vault alone. Leave the old
export script in place until the vault path is verified, then delete it.

## Security posture

[references/security.md](references/security.md) has the threat model: what this design
does and does not protect against, why the host disk should be encrypted, and the ladder
from client secret → certificate → Azure Arc managed identity. Read it before telling me
this setup is "secure" — it is good practice, but it is not a defence against host
compromise, and on a shared host one root exploit reaches every app.
