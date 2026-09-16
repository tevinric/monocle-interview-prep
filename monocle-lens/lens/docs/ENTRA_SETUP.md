# Sign-in with Microsoft Entra ID — setup guide

Follow this once per environment. It takes about fifteen minutes in the Azure portal and
five in the Key Vault. At the end, Lens will refuse every API call that does not carry a
valid access token issued by your tenant, for this application, to an account you have
assigned.

Until you do it, nothing changes: `LENS-ENV-TYPE` defaults to `DEV`, sign-in is bypassed,
and the browser never even downloads the Microsoft authentication library.

---

## What you are building

```
   browser                     Entra ID                     Lens API
      │                           │                             │
      │ 1. "Sign in with          │                             │
      │     Microsoft"  ────────► │                             │
      │                           │  2. the person signs in,    │
      │                           │     MFA, consent            │
      │ 3. authorization code ◄── │                             │
      │    (+ PKCE verifier,      │                             │
      │     never leaves the tab) │                             │
      │ 4. code ────────────────► │                             │
      │ 5. access token   ◄────── │                             │
      │                                                         │
      │ 6. GET /api/runs   Authorization: Bearer <token>  ─────► │
      │                                                         │ 7. validates the
      │                                                         │    SIGNATURE against
      │                                                         │    your tenant's keys,
      │                                                         │    plus issuer,
      │                                                         │    audience, tenant,
      │                                                         │    scope, allow-list
      │ 8. data, or 401 / 403                            ◄───── │
```

Two things are worth being clear about, because they are what the design turns on:

- **There is no client secret anywhere in the browser.** This is the authorization-code
  flow with PKCE. A public client cannot keep a secret, so it does not have one; the code
  returned in step 3 is useless without the verifier the tab generated in step 1.
- **The frontend does not decide who gets in.** It obtains a token and shows what the API
  returns. Every request is re-validated server-side in `backend/lens/auth.py`. A token
  that the browser fabricated, borrowed from another application, or kept past its expiry
  is rejected there. The login page is a convenience; the API is the control.

---

## Before you start

- You need to be able to create an app registration in the tenant — **Application
  Developer**, **Cloud Application Administrator** or **Global Administrator**.
- Granting admin consent (step 5) needs **Cloud Application Administrator** or
  **Global Administrator**. If that is not you, a tenant admin can click one button.
- Know the URLs Lens will be served from. For a laptop that is `http://localhost:3100`
  (the default `LENS_FRONTEND_PORT`).

Throughout, replace:

| Placeholder | Means |
|---|---|
| `<TENANT-ID>` | Directory (tenant) ID — a GUID |
| `<CLIENT-ID>` | Application (client) ID of the Lens registration — a GUID |
| `<VAULT>` | Your Key Vault name |

---

## Step 1 — Create the app registration

1. Portal → **Microsoft Entra ID** → **App registrations** → **New registration**.
2. **Name:** `Lens` (this is what people see on the consent screen — name it for them,
   not for you).
3. **Supported account types:** *Accounts in this organizational directory only
   (single tenant)*. Lens is an internal tool; a multi-tenant registration would let
   accounts from any directory reach the sign-in page.
4. **Redirect URI:** leave it empty for now — step 2 adds it as the right platform type.
5. **Register**.

On the **Overview** blade, copy the **Application (client) ID** and the
**Directory (tenant) ID**. You need both in step 9.

---

## Step 2 — Add the SPA platform and redirect URIs

1. In the registration → **Authentication** → **Add a platform** → **Single-page
   application**.
2. **Redirect URIs** — add one per environment, exactly, including the scheme and port:

   ```
   http://localhost:3100
   https://lens.your-domain.example        ← whatever you deploy to
   ```

3. **Front-channel logout URL** (optional): the same origin.
4. Under *Implicit grant and hybrid flows*, leave **both boxes unticked**. Lens uses
   neither implicit tokens nor hybrid flow.
5. **Save**.

> **Why the SPA platform and not Web.** The *Single-page application* type is what makes
> the token endpoint CORS-enabled and PKCE-required. Registering the same URI under *Web*
> instead produces `AADSTS9002326: Cross-origin token redemption is permitted only for the
> 'Single-Page Application' client-type` — the single most common way to get this wrong.

> **Trailing slashes matter.** `http://localhost:3100` and `http://localhost:3100/` are
> different URIs to Entra. Lens sends `window.location.origin`, which has **no** trailing
> slash.

---

## Step 3 — Expose the API and its scope

The same registration is both the app the person signs into and the API the token is for.
That is the simplest arrangement that still produces a properly audienced token.

1. → **Expose an API** → next to *Application ID URI*, **Add** → accept the default
   `api://<CLIENT-ID>` → **Save**.
2. **Add a scope**:

   | Field | Value |
   |---|---|
   | Scope name | `Lens.Access` |
   | Who can consent | *Admins and users* |
   | Admin consent display name | `Use Lens` |
   | Admin consent description | `Allows the signed-in user to ask questions and read audit traces in Lens.` |
   | User consent display name | `Use Lens` |
   | User consent description | `Lets you ask questions and read audit traces in Lens.` |
   | State | *Enabled* |

3. **Add scope**.

The full scope string is now `api://<CLIENT-ID>/Lens.Access`. The backend builds this
string itself from `LENS-ENTRA-*`; you do not configure it twice.

> If you change the scope name from `Lens.Access`, set `LENS-ENTRA-API-SCOPE` to match.

---

## Step 4 — Let the SPA call its own API without a consent prompt

Still on **Expose an API**:

1. **Add a client application**.
2. **Client ID:** paste this registration's own `<CLIENT-ID>`.
3. Tick the `api://<CLIENT-ID>/Lens.Access` scope.
4. **Add application**.

This pre-authorises the SPA half of the registration to the API half, so nobody is asked
to consent to an application calling itself.

---

## Step 5 — API permissions

1. → **API permissions** → **Add a permission** → **My APIs** → **Lens**.
2. **Delegated permissions** → tick `Lens.Access` → **Add permissions**.
3. Click **Grant admin consent for \<tenant\>** and confirm.

Lens needs no Microsoft Graph permission at all. `User.Read` is added by default on some
tenants; you can leave it or remove it — the backend ignores everything except its own
scope.

---

## Step 6 — Force v2 access tokens

1. → **Manifest**.
2. Find `requestedAccessTokenVersion` (older manifest editor: `accessTokenAcceptedVersion`)
   and set it to `2`:

   ```json
   "requestedAccessTokenVersion": 2
   ```

3. **Save**.

A v2 token has issuer `https://login.microsoftonline.com/<TENANT-ID>/v2.0` and audience
`api://<CLIENT-ID>`. Lens also accepts the v1 forms (`https://sts.windows.net/<TENANT-ID>/`
and the bare client id) so a tenant left on the default still works — but v2 is what you
want, and it is what the guide assumes when you read a token in the troubleshooting step.

---

## Step 7 — Decide who may sign in

This is the control that matters, and it is not in the app registration — it is on the
**enterprise application** (the service principal the registration created).

1. Portal → **Microsoft Entra ID** → **Enterprise applications** → **Lens**.
2. → **Properties** → **Assignment required?** → **Yes** → **Save**.
3. → **Users and groups** → **Add user/group** → assign the people or the group who may
   use Lens.

With *Assignment required* on, anyone else who reaches the login page signs in
successfully at Microsoft and is then refused a token for Lens, with a message naming the
application. Nothing of Lens is exposed to them.

Lens can enforce a **second** list of its own, in configuration rather than in Entra, for
when you want to narrow access without a portal trip (see `LENS-ENTRA-ALLOWED-UPNS` in
step 9). Leave it empty and Entra's assignment list is the only gate.

---

## Step 8 — Group claims (optional)

Only needed if you intend to use `LENS-ENTRA-ALLOWED-GROUPS`.

1. Registration → **Token configuration** → **Add groups claim**.
2. Choose **Security groups** (or *Groups assigned to the application*, which is smaller
   and does not hit the claim limit on a large tenant).
3. Under **Access**, tick **Group ID**.

The claim then carries group **object IDs**, not names, so
`LENS-ENTRA-ALLOWED-GROUPS` must contain object IDs:

```
a1b2c3d4-0000-0000-0000-000000000000,e5f6a7b8-0000-0000-0000-000000000000
```

If the list is set and the token carries no `groups` claim at all, Lens refuses the
request and says so — that is nearly always this step having been skipped.

---

## Step 9 — Put the values in the Key Vault

Lens reads these at startup through `keyvault-init` (see `keyvault/fetch_secrets.py`).
None of them is a credential; they are in the vault because they are what differs between
a laptop and a deployment, and because the switch that turns authentication **on** should
not be something a shell variable on the host can turn off.

```bash
VAULT=<VAULT>

# The switch. PROD enforces sign-in; DEV bypasses it.
az keyvault secret set --vault-name $VAULT --name LENS-ENV-TYPE            --value "PROD"

az keyvault secret set --vault-name $VAULT --name LENS-ENTRA-TENANT-ID     --value "<TENANT-ID>"
az keyvault secret set --vault-name $VAULT --name LENS-ENTRA-SPA-CLIENT-ID --value "<CLIENT-ID>"

# Optional — only if you split the API into a SECOND registration. Left unset, the SPA's
# own client id is used, which is the setup this guide describes.
# az keyvault secret set --vault-name $VAULT --name LENS-ENTRA-API-CLIENT-ID --value "<API-CLIENT-ID>"

# Optional — defaults to Lens.Access.
# az keyvault secret set --vault-name $VAULT --name LENS-ENTRA-API-SCOPE --value "Lens.Access"

# Optional second gate, on top of the Entra assignment list. Comma-separated.
# az keyvault secret set --vault-name $VAULT --name LENS-ENTRA-ALLOWED-UPNS   --value "tevin@example.com,someone@example.com"
# az keyvault secret set --vault-name $VAULT --name LENS-ENTRA-ALLOWED-GROUPS --value "<GROUP-OBJECT-ID>"
```

The service principal in `lens_kv_init.sh` must be able to **get** each of these secrets.
If your vault uses RBAC, `Key Vault Secrets User` on the vault covers them; if it uses
access policies, the existing Lens policy already has *Get*, and these names only need to
be added if you have scoped it secret by secret.

---

## Step 10 — Restart and verify

```bash
cd lens
source ./lens_kv_init.sh
docker compose up --build -d
```

**1. The backend says it is enforcing.**

```bash
docker compose logs backend | grep -i "Sign-in:"
# Sign-in: Entra ID enforced (tenant …, audience api://…, scope Lens.Access).
```

If it says `Sign-in: BYPASSED`, `LENS-ENV-TYPE` did not arrive — check
`docker compose logs keyvault-init`.

**2. The configuration is real and the validator is strict.**

```bash
make check-auth
```

This fetches your tenant's OpenID metadata and signing keys, then signs a set of
deliberately wrong tokens locally and requires every one of them to be rejected — wrong
issuer, wrong audience, wrong tenant, expired, no scope, and one signed by a key your
tenant never published.

**3. The API refuses an anonymous call.**

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:5100/api/runs     # 401
curl -s http://localhost:5100/api/health                                    # 200, "auth":"entra"
curl -s http://localhost:5100/api/auth/config                               # 200, the public config
```

`/api/health` and `/api/auth/config` are the only two routes that answer without a token:
one is the container healthcheck, the other is how the browser learns where to sign in.

**4. Sign in.** Open `http://localhost:3100`. You should get the Lens sign-in page, then
Microsoft, then the application. The navy rail shows your name and a **Sign out** link.

**5. Confirm what the API thinks.** In the browser devtools console on a signed-in tab:

```js
await (await fetch('/api/auth/me', {
  headers: { Authorization: 'Bearer ' + JSON.parse(
    Object.entries(sessionStorage).find(([k]) => k.includes('accesstoken'))[1]).secret }
})).json()
```

Or more simply, watch the Network tab: every `/api/` request carries an
`Authorization: Bearer` header, and `/api/auth/me` returns the name, UPN, object id,
tenant and scopes the **backend** extracted from the token it verified.

---

## Switching back to DEV

```bash
az keyvault secret set --vault-name <VAULT> --name LENS-ENV-TYPE --value "DEV"
docker compose up -d --force-recreate backend frontend
```

Sign-in is bypassed, the login page never appears, and MSAL is never downloaded. The
bypass is deliberately visible rather than silent:

- the backend logs a warning at startup,
- `/api/health` reports `"auth": "bypassed"`,
- `"env_type"` and `"auth"` are written into **every run's configuration snapshot**, so a
  trace recorded on an unauthenticated stack says so nine months later.

---

## What the backend checks, claim by claim

Useful to have to hand — it is the question a security reviewer asks.

| Check | Claim | Rejecting |
|---|---|---|
| Signature | — | Any token not signed by a current key of your tenant, fetched live from the tenant's JWKS and cached |
| Issuer | `iss` | Tokens from any other directory |
| Audience | `aud` | Tokens minted for Graph or for a different API in the same tenant — this is what stops a token being replayed against Lens |
| Tenant | `tid` | Belt and braces with the issuer |
| Expiry | `exp` / `nbf` | Expired or not-yet-valid tokens, with 60 seconds of leeway for clock skew |
| Scope | `scp` | Tokens without `Lens.Access`, including app-only tokens, which carry `roles` and no user |
| Account | `preferred_username` | Accounts absent from `LENS-ENTRA-ALLOWED-UPNS`, when that list is set |
| Group | `groups` | Accounts in none of `LENS-ENTRA-ALLOWED-GROUPS`, when that list is set |

Everything except the last two is mandatory and cannot be configured off while
`LENS-ENV-TYPE` is `PROD`.

---

## Troubleshooting

| What you see | What it means |
|---|---|
| `AADSTS50011: The redirect URI … does not match` | The URI in step 2 is not exactly the origin the browser is on. Check scheme, port and trailing slash. |
| `AADSTS9002326: Cross-origin token redemption …` | The redirect URI is registered under **Web** instead of **Single-page application**. Delete it and re-add under the SPA platform. |
| `AADSTS65001: The user or administrator has not consented` | Step 5's admin consent was not granted, or step 4's pre-authorisation is missing. |
| `AADSTS50105: … is not assigned to a role for the application` | *Assignment required* is on (step 7) and this account is not assigned. Working as intended — assign the account. |
| 401 `This token was issued for a different application` | `aud` is not `api://<CLIENT-ID>`. Usually the SPA asked for the wrong scope, or `LENS-ENTRA-SPA-CLIENT-ID` is a different registration from the one exposing the API. |
| 401 `This token was issued by a different directory` | `LENS-ENTRA-TENANT-ID` does not match the tenant the person signed into. |
| 403 `This token does not carry the Lens.Access scope` | The scope name in Entra and `LENS-ENTRA-API-SCOPE` disagree, or the SPA requested `User.Read` instead. |
| 403 `This account is not on the Lens access list` | `LENS-ENTRA-ALLOWED-UPNS` is set and does not include this UPN. |
| 403 `This account is not in a group with access` and the detail says *no groups claim* | Step 8 was skipped: the token has no `groups` claim to check. |
| The login page never appears, and the app loads straight away | `LENS-ENV-TYPE` is `DEV`. Check `/api/auth/config` — it will say `"mode": "open"`. |
| Backend exits at startup naming `LENS_ENTRA_*` | `LENS-ENV-TYPE` is `PROD` with the identifiers missing. A PROD container that came up half-configured would serve the whole API unauthenticated, so it refuses to start instead. |

---

## Appendix — the same thing on the CLI

For a scripted environment. Portal and CLI produce the same registration.

```bash
TENANT=<TENANT-ID>
az login --tenant $TENANT

# 1–2. Registration with the SPA redirect URIs
APP_ID=$(az ad app create \
  --display-name "Lens" \
  --sign-in-audience AzureADMyOrg \
  --enable-id-token-issuance false \
  --enable-access-token-issuance false \
  --query appId -o tsv)

az ad app update --id $APP_ID --set \
  spa='{"redirectUris":["http://localhost:3100","https://lens.your-domain.example"]}'

# 3–4, 6. Application ID URI, the scope, self pre-authorisation, v2 tokens.
SCOPE_ID=$(uuidgen)
cat > /tmp/lens-api.json <<JSON
{
  "identifierUris": ["api://$APP_ID"],
  "api": {
    "requestedAccessTokenVersion": 2,
    "oauth2PermissionScopes": [{
      "id": "$SCOPE_ID",
      "value": "Lens.Access",
      "type": "User",
      "isEnabled": true,
      "adminConsentDisplayName": "Use Lens",
      "adminConsentDescription": "Allows the signed-in user to ask questions and read audit traces in Lens.",
      "userConsentDisplayName": "Use Lens",
      "userConsentDescription": "Lets you ask questions and read audit traces in Lens."
    }],
    "preAuthorizedApplications": [{
      "appId": "$APP_ID",
      "delegatedPermissionIds": ["$SCOPE_ID"]
    }]
  }
}
JSON
az rest --method PATCH \
  --url "https://graph.microsoft.com/v1.0/applications(appId='$APP_ID')" \
  --headers Content-Type=application/json \
  --body @/tmp/lens-api.json

# 7. Assignment required, then assign people in the portal or with Graph.
SP_ID=$(az ad sp create --id $APP_ID --query id -o tsv 2>/dev/null || \
        az ad sp show --id $APP_ID --query id -o tsv)
az rest --method PATCH \
  --url "https://graph.microsoft.com/v1.0/servicePrincipals/$SP_ID" \
  --headers Content-Type=application/json \
  --body '{"appRoleAssignmentRequired": true}'

# 9. Into the vault
az keyvault secret set --vault-name <VAULT> --name LENS-ENV-TYPE            --value PROD
az keyvault secret set --vault-name <VAULT> --name LENS-ENTRA-TENANT-ID     --value $TENANT
az keyvault secret set --vault-name <VAULT> --name LENS-ENTRA-SPA-CLIENT-ID --value $APP_ID

echo "client id: $APP_ID"
```

---

## Where this lives in the code

| Concern | File |
|---|---|
| Token validation, the gate in front of every route, `/api/auth/config` | `backend/lens/auth.py` |
| `LENS_ENV_TYPE` and the Entra settings, and refusing to start half-configured | `backend/lens/config.py` |
| Which vault secrets are read | `keyvault/fetch_secrets.py` |
| Acquiring the token in the browser, and sending it | `frontend/src/auth.js`, `frontend/src/api.js` |
| The gate in front of the interface | `frontend/src/AuthGate.jsx` |
| The sign-in page | `frontend/src/pages/Login.jsx` |
| `make check-auth` | `backend/lens/authcheck.py` |
