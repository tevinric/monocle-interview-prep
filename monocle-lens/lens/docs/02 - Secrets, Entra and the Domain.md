# 02 — Secrets, Entra and the Domain

> **Navigation:** [[00 - Monocle Lens Pi Deployment Home]] | Prev: [[01 - Pi Survey and Prerequisites]] | Next: [[03 - Deploy the Stack on the Pi]]

---

## 🎯 Goal of This Step

By the end of this page the Pi will hold the four Key Vault bootstrap variables, the vault will hold every `LENS-*` secret, sign-in will be switched to `PROD`, and — critically — the Entra app registration will accept `https://monocle-interview-prep-tevin-richard.unismartsolutions.co.za` as a redirect URI.

> ⚠️ Warning: Do this page **before** the tunnel. If you deploy first and add the redirect URI later, your first visit to the domain fails with `AADSTS50011` and you will waste time suspecting the tunnel.

---

## 🔐 How Lens Handles Secrets

Nothing sensitive lives on the Pi's disk in plaintext, and nothing appears in `docker inspect`:

```
Your shell (4 variables)  ──►  lens_keyvault_init  ──►  Azure Key Vault
   LENS_AZURE_KEYVAULT_URL      (runs once, exits 0)         │
   LENS_AZURE_TENANT_ID                                      │ pulls every LENS-* secret
   LENS_AZURE_CLIENT_ID                                      ▼
   LENS_AZURE_CLIENT_SECRET     writes ──► lens_secrets volume (mounted READ-ONLY
                                                                by postgres + backend)
```

`postgres` and `backend` both wait for `keyvault-init` to exit `0`. A missing secret stops the stack rather than starting it half-configured.

---

## 🗝️ Part A — Confirm the Vault Contents

These must exist in the Key Vault. If you already ran Lens on your laptop, they are there — this is a verification pass.

| Key Vault secret | What it is |
|---|---|
| `LENS-DB-NAME` | PostgreSQL database name |
| `LENS-DB-USER` | PostgreSQL role |
| `LENS-DB-PASSWORD` | PostgreSQL password |
| `LENS-OPENAI-API-KEY` | OpenAI API key (`sk-…`) |

And, for sign-in (see the table in `README.md` and **[ENTRA_SETUP.md](ENTRA_SETUP.md)**):

| Key Vault secret | Set it to | Why |
|---|---|---|
| `LENS-ENV-TYPE` | **`PROD`** | Requires a valid Entra access token on every API call. `DEV` bypasses sign-in — never on a public URL. |
| `LENS-ENTRA-TENANT-ID` | Directory (tenant) ID | Required when `PROD` |
| `LENS-ENTRA-SPA-CLIENT-ID` | Application (client) ID of the Lens registration | Required when `PROD` |
| `LENS-ENTRA-API-SCOPE` | `Lens.Access` (default) | The delegated scope the token must carry |
| `LENS-ENTRA-ALLOWED-UPNS` | *(optional)* | A second allow-list, on top of Entra's own assignment |

From a machine with the Azure CLI signed in:

```bash
VAULT=<your-vault-name>

# List what is there (names only — values are not printed)
az keyvault secret list --vault-name "$VAULT" --query "[?starts_with(name,'LENS-')].name" -o tsv

# Switch sign-in ON for this deployment
az keyvault secret set --vault-name "$VAULT" --name LENS-ENV-TYPE --value PROD

# Verify the value took (prints PROD)
az keyvault secret show --vault-name "$VAULT" --name LENS-ENV-TYPE --query value -o tsv
```

> 💡 Tip: `LENS-ENV-TYPE` deliberately lives in the vault rather than in `.env` or `docker-compose.yml`. The switch that turns authentication **on** should not be something a shell variable on the host can turn **off**.

---

## 🔑 Part B — The Four Bootstrap Variables on the Pi

These are the credentials of the **service principal that reads the vault** — not the app registration users sign in with.

```bash
cd /home/reunionparadise/sites/monocle-interview-prep/monocle-lens/lens
cp lens_kv_init.sh.example lens_kv_init.sh
nano lens_kv_init.sh
```

Fill in the four values:

```bash
export LENS_AZURE_KEYVAULT_URL="https://<your-vault-name>.vault.azure.net/"
export LENS_AZURE_TENANT_ID="<tenant-guid>"
export LENS_AZURE_CLIENT_ID="<service-principal-app-id>"
export LENS_AZURE_CLIENT_SECRET="<service-principal-secret-value>"
```

Lock the file down — it is the one genuinely sensitive file on the Pi:

```bash
chmod 600 lens_kv_init.sh
ls -l lens_kv_init.sh        # expect: -rw------- 1 reunionparadise reunionparadise
```

Load it into your shell and check it took:

```bash
source ./lens_kv_init.sh
echo "$LENS_AZURE_KEYVAULT_URL"      # should print your vault URL
```

> ⚠️ Warning: `source` affects **only the current shell**. A new SSH session, or a reboot, starts without these variables and `docker compose` will refuse to run with an explicit error. That is by design. [[06 - Operations, Updates and Reboots]] covers what survives a reboot and how to automate it if you want to.

> 💡 Tip: The variable names are prefixed `LENS_` on purpose. If you also source another app's init script into the same shell, unprefixed names would silently leave one app authenticating as another app's principal.

---

## 🌐 Part C — Add the Production URL to Entra

**This is the step people forget.** The Lens SPA sends `window.location.origin` as its redirect URI. On the Pi that origin becomes the new domain, and Entra rejects any redirect URI it has not been told about.

1. Azure Portal → **Microsoft Entra ID** → **App registrations** → your **Lens** registration.
2. → **Authentication**.
3. Under the **Single-page application** platform, click **Add URI** and enter exactly:

   ```
   https://monocle-interview-prep-tevin-richard.unismartsolutions.co.za
   ```

4. Leave the existing `http://localhost:3100` entry in place — it keeps laptop development working.
5. *(Optional)* Set **Front-channel logout URL** to the same URL.
6. Under *Implicit grant and hybrid flows*, both boxes stay **unticked**.
7. **Save**.

> ⚠️ Warning: **No trailing slash.** `https://monocle-interview-prep-tevin-richard.unismartsolutions.co.za/` is a *different* URI to Entra and will not match. Copy the line above exactly.

> ⚠️ Warning: It must sit under the **Single-page application** platform, not **Web**. The SPA type is what makes the token endpoint CORS-enabled and PKCE-required; registering it under *Web* produces `AADSTS9002326: Cross-origin token redemption is permitted only for the 'Single-Page Application' client-type`.

Confirm the platform and URI list:

```
Authentication
└── Single-page application
    ├── http://localhost:3100
    └── https://monocle-interview-prep-tevin-richard.unismartsolutions.co.za
```

---

## 👥 Part D — Decide Who May Sign In

The control that matters is on the **enterprise application**, not the registration:

1. Portal → **Microsoft Entra ID** → **Enterprise applications** → **Lens**.
2. → **Properties** → **Assignment required?** → **Yes** → **Save**.
3. → **Users and groups** → **Add user/group** → add yourself, and anyone who should be able to use the deployment.

Anyone else signs in successfully at Microsoft and is then refused a token for Lens.

> 💡 Tip: If you are demonstrating this to an interviewer, decide **now** whether they get an account. If not, they will watch you drive — which is usually what you want anyway, since the tour ([[00 - Monocle Lens Pi Deployment Home]] links it) and the audit trail are best narrated. See the demo-day decision box in [[05 - Cloudflare Access and Hardening]].

If the full registration does not yet exist, stop here and work through **[ENTRA_SETUP.md](ENTRA_SETUP.md)** end to end — it covers the registration, the exposed scope, pre-authorisation and the v2 token manifest setting — then come back.

---

## ✅ Checklist

- [ ] All four `LENS-DB-*` / `LENS-OPENAI-API-KEY` secrets present in the vault
- [ ] `LENS-ENV-TYPE` = **`PROD`**
- [ ] `LENS-ENTRA-TENANT-ID` and `LENS-ENTRA-SPA-CLIENT-ID` set
- [ ] `lens_kv_init.sh` created on the Pi and `chmod 600`
- [ ] `source ./lens_kv_init.sh` populates the four variables
- [ ] `https://monocle-interview-prep-tevin-richard.unismartsolutions.co.za` added as a **SPA** redirect URI, **no trailing slash**
- [ ] `localhost:3100` redirect URI kept for laptop work
- [ ] *Assignment required* = Yes, and the right people assigned

---

> **Next Step:** [[03 - Deploy the Stack on the Pi]] — build the images, start the stack, and prove it works on loopback before anything is exposed.
