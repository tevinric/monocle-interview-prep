# Naming on a shared Docker host

All of these apps run on one Docker daemon. Docker volume, container and network names
declared with an explicit `name:` are **global to that daemon** — Compose does *not*
namespace them by project. Two apps that pick the same name get the same object.

## Why this is dangerous rather than merely annoying

A container-name clash is loud (`Conflict. The container name ... is already in use`).
A **volume** clash is silent:

1. App A's `keyvault-init` writes `/secrets/backend.env` with App A's secrets.
2. App B's `keyvault-init` runs later and overwrites the same file with App B's secrets.
3. App A's backend restarts and sources App B's database password and Flask
   `SECRET_KEY`.

Nothing errors. The symptom is a confusing auth failure days later — or, if both apps
happen to share a database role, two apps signing sessions with the same key.

## The five names that must be app-scoped

| Thing | Pattern | Example (kts_hr_app) |
|---|---|---|
| Secrets volume | `<slug>_secrets` | `kts_hr_secrets` |
| Init container | `<slug>_keyvault_init` | `kts_hr_app_keyvault_init` |
| Network | `<slug>_network` | `kts_hr_network` |
| Vault secret names | `<VAULT_PREFIX>-<NAME>` | `KTSAPP-DB-PASSWORD` |
| Bootstrap shell vars | `<VAULT_PREFIX>_AZURE_*` | `KTSAPP_AZURE_CLIENT_ID` |

The bootstrap variables are the least obvious and matter just as much. The operator may
source more than one app's init script into a single shell:

```bash
source ./app_a_kv_init.sh
source ./app_b_kv_init.sh     # unprefixed AZURE_CLIENT_ID would clobber app A's
docker compose -f app_a/docker-compose.yml up -d   # ← now authenticating as app B
```

With `<VAULT_PREFIX>_` prefixes this is harmless; without them one app silently
authenticates as another app's principal.

## Choosing the prefixes

Three distinct identifiers, and they are allowed to differ:

- **`<slug>`** — lowercase, matches the container/volume naming the app already uses.
  Take it from the existing `container_name:` values, not from the directory name.
- **`<ENV_PREFIX>`** — the uppercase prefix the application code already reads
  (`KTSHRAPP_DB_HOST` → `KTSHRAPP`). **Never rename this**; it would mean editing every
  `os.getenv` call.
- **`<VAULT_PREFIX>`** — the Key Vault namespace. Must be `[A-Z][A-Z0-9]*`: Key Vault
  secret names permit only letters, digits and hyphens, and the same prefix is used for
  shell variables, which forbid hyphens. So no `-` and no `_`.

`kts_hr_app` uses slug `kts_hr` / `kts_hr_app`, env prefix `KTSHRAPP`, vault prefix
`KTSAPP`. Differing prefixes are fine — the mapping is explicit in `SECRET_MAP`.

Keep vault prefixes short and unmistakable; they are what separates this app's secrets
from every other app's in a shared vault. Check the existing ones before inventing a new
one:

```bash
az keyvault secret list --vault-name "$VAULT" --query "[].name" -o tsv | cut -d- -f1 | sort -u
```
