# Vault setup, access grants and secret creation

## Choosing the vault: one per app, or one shared

**Prefer one vault per application.** Vaults are cheap, and it is the only design where
the blast radius of a leaked client secret is exactly one app.

If you must share a vault across apps, understand this clearly:

> **The `<VAULT_PREFIX>-` name prefix is a convention, not a permission boundary.**
> A principal granted `Key Vault Secrets User` at *vault scope* can read **every**
> secret in that vault, including every other application's.

There is a way to make a shared vault genuinely safe — see "Per-secret scoping" below.

## Create the service principal — one per app

```bash
az ad sp create-for-rbac --name "sp-<app-slug>-keyvault" --skip-assignment
```

Record `appId` (client ID), `password` (client secret) and `tenant`. Never reuse one
app's principal for another: on a shared host that collapses every app into a single
credential.

Set an expiry you will actually honour — a stolen client secret is only as dangerous as
it is long-lived:

```bash
az ad app credential reset --id <appId> --years 1
```

## Grant access

The principal needs **get on secrets** and nothing else. Never grant `set`, `delete`, or
a management-plane role.

### Per-secret scoping (required for a shared vault)

Azure RBAC for Key Vault supports scoping a data-plane role to an **individual secret**.
This is what turns the name prefix into a real boundary.

It works here because `fetch_secrets.py` retrieves secrets **by exact name and never
lists the vault** — listing would require vault-level scope and defeat this. Do not add
a `list_properties_of_secrets()` call.

```bash
VAULT=<vault-name>
SP=<service-principal-client-id>
VAULT_ID=$(az keyvault show --name "$VAULT" --query id -o tsv)

for SECRET in $(az keyvault secret list --vault-name "$VAULT" \
                  --query "[?starts_with(name,'<VAULT_PREFIX>-')].name" -o tsv); do
  az role assignment create \
    --role "Key Vault Secrets User" \
    --assignee "$SP" \
    --scope "$VAULT_ID/secrets/$SECRET"
done
```

Re-run the loop after adding a new secret — a new secret is **not** covered by existing
per-secret assignments, and the stack will fail closed with a `Forbidden` error naming
it. That is the intended behaviour.

### Vault-scoped grant (acceptable only for a single-app vault)

```bash
az role assignment create \
  --role "Key Vault Secrets User" \
  --assignee "$SP" \
  --scope "$VAULT_ID"
```

### Access-policy vaults (legacy model)

Access policies cannot scope below the vault. If the vault is shared and uses access
policies, migrate it to RBAC (`--enable-rbac-authorization true`) or split the vault.

```bash
az keyvault set-policy --name "$VAULT" --spn "$SP" --secret-permissions get
```

## Vault hardening

```bash
az keyvault update --name "$VAULT" --enable-purge-protection true
az keyvault update --name "$VAULT" --retention-days 90
```

- Enable **diagnostic settings** → Log Analytics, and alert on any principal reading a
  `<VAULT_PREFIX>-` secret that is not this app's. Audit is the main thing a vault gives
  you that shell exports never could — it is wasted if switched off.
- If the host has a stable egress IP, add a **vault firewall** rule for it.
- Separate vaults per environment (prod / dev), not just per app.

## Create the secrets

```bash
VAULT=<vault-name>

az keyvault secret set --vault-name "$VAULT" --name <VAULT_PREFIX>-DB-NAME     --value '<app>_db'
az keyvault secret set --vault-name "$VAULT" --name <VAULT_PREFIX>-DB-USER     --value '<app>_user'
az keyvault secret set --vault-name "$VAULT" --name <VAULT_PREFIX>-DB-PASSWORD --value "$(openssl rand -base64 24)"
az keyvault secret set --vault-name "$VAULT" --name <VAULT_PREFIX>-SECRET-KEY  --value "$(openssl rand -base64 48)"
```

Give secrets an expiry date so staleness is visible:

```bash
az keyvault secret set --vault-name "$VAULT" --name <VAULT_PREFIX>-SECRET-KEY \
  --value "$(openssl rand -base64 48)" --expires "$(date -u -d '+1 year' +%Y-%m-%dT%H:%M:%SZ)"
```

> **The database credentials only take effect when the postgres data volume is first
> created.** For an app with an existing volume, the vault values must match the role
> already in it. Change a live password with `ALTER ROLE <user> WITH PASSWORD '<new>';`
> and then update the vault — never the vault alone.

## Rotation

```bash
az keyvault secret set --vault-name "$VAULT" --name <VAULT_PREFIX>-SECRET-KEY --value "$(openssl rand -base64 48)"
source ./<slug>_kv_init.sh
docker compose up -d --force-recreate keyvault-init backend
```

`keyvault-init` re-runs on every `docker compose up`, so rotation needs no code or file
changes — only a restart of the services that consume the secret. Rotating a database
password additionally requires the `ALTER ROLE` above.
