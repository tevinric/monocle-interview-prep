# 07 — Troubleshooting

> **Navigation:** [[00 - Monocle Lens Pi Deployment Home]] | Prev: [[06 - Operations, Updates and Reboots]]

---

## 🎯 Goal of This Section

Every failure across the deployment, organised by the stage it appears in, with the command that identifies it. Work top-down: most "the tunnel is broken" reports turn out to be stage 2.

---

## 🧭 Narrow It Down First

Run these four in order. The first one that fails tells you which section to read.

```bash
# 1. Is the app running at all?
docker ps --filter name=lens_ --format 'table {{.Names}}\t{{.Status}}'

# 2. Does it answer on loopback?
curl -s -o /dev/null -w 'frontend %{http_code}\n' http://127.0.0.1:3100/
curl -s http://127.0.0.1:5100/api/health; echo

# 3. Is our tunnel up?
systemctl is-active cloudflared-monocle-lens

# 4. Does the public URL answer?
curl -sI https://monocle-interview-prep-tevin-richard.unismartsolutions.co.za | head -1
```

| First failure | Read |
|---|---|
| 1 | 🟥 Stage 1 and 🟧 Stage 2 |
| 2 | 🟧 Stage 2 |
| 3 | 🟦 Stage 3 |
| 4 | 🟦 Stage 3 and 🟪 Stage 4 |
| None — but sign-in fails | 🟩 Stage 5 |

---

## 🟥 Stage 1 — Build and Startup

### `required variable LENS_AZURE_KEYVAULT_URL is missing a value`

Your shell has no vault variables. Expected after a reboot or in a fresh SSH session.

```bash
cd /home/reunionparadise/sites/monocle-interview-prep/monocle-lens/lens
source ./lens_kv_init.sh
```

### `port is already allocated`

Another app took the port between your survey and your deploy.

```bash
sudo ss -ltnp | grep -E '3100|5100|5439'
```

Change the number in `.env` (keeping the `127.0.0.1:` prefix), then `make up`. If you change the **frontend** port, also update `service: http://127.0.0.1:<new-port>` in `/etc/cloudflared/monocle-lens.yml` and `sudo systemctl restart cloudflared-monocle-lens`.

### The frontend build is "Killed" with no error

Out of memory during the Vite build. Raise swap and rebuild:

```bash
free -h
sudo dphys-swapfile swapoff
sudo sed -i 's/^CONF_SWAPSIZE=.*/CONF_SWAPSIZE=2048/' /etc/dphys-swapfile
sudo dphys-swapfile setup && sudo dphys-swapfile swapon
docker compose build frontend
```

### `lens_keyvault_init` exits non-zero and nothing else starts

That is the stack refusing to start half-configured. The log names the cause:

```bash
docker logs lens_keyvault_init
```

| Message mentions | Cause | Fix |
|---|---|---|
| authentication / AADSTS | Wrong service-principal values | Re-check the four values in `lens_kv_init.sh` ([[02 - Secrets, Entra and the Domain]]) |
| Forbidden / access policy | The principal cannot read the vault | Grant it `get`/`list` on secrets |
| `SecretNotFound` | A `LENS-*` secret is missing | Create it in the vault |
| DNS / timeout | The Pi cannot reach Azure | `curl -I https://<vault>.vault.azure.net/` |

### `permission denied` on every `docker` command

```bash
sudo usermod -aG docker $USER
newgrp docker      # or log out and back in
```

---

## 🟧 Stage 2 — The App on Loopback

### `/api/health` says `"auth":"bypassed"` or `"env_type":"DEV"`

**Do not expose this.** The vault still says `DEV`.

```bash
az keyvault secret set --vault-name <vault> --name LENS-ENV-TYPE --value PROD
cd /home/reunionparadise/sites/monocle-interview-prep/monocle-lens/lens
source ./lens_kv_init.sh
docker compose up -d --force-recreate keyvault-init backend
curl -s http://127.0.0.1:5100/api/health
```

### `/api/health` reports the database as unreachable

```bash
docker compose ps                 # is lens_db healthy?
docker compose logs --tail=50 postgres
docker compose logs --tail=50 backend
```

A first start that never became healthy usually means the credentials on the `lens_secrets` volume do not match the data directory in `lens_pg_data` — which happens if the vault password changed **after** the database was initialised. Either restore the old password in the vault, or (destroying all data) `make down && docker volume rm lens_pg_data && make up`.

### The app loads but every screen is empty

The corpus was never ingested, or history was never seeded.

```bash
make ingest
make seed
```

### Answers fail with a model error

```bash
make check-model
```

This calls each configured model with the exact parameters Lens sends and prints what came back — a wrong model name or an unsupported parameter surfaces here in seconds.

---

## 🟦 Stage 3 — The Tunnel

### `cloudflared-monocle-lens` will not start

```bash
sudo journalctl -u cloudflared-monocle-lens -n 50 --no-pager
```

| Log says | Cause | Fix |
|---|---|---|
| `tunnel credentials file not found` | Wrong path or UUID in the config | `sudo ls -la /etc/cloudflared/` and check both `<TUNNEL-ID>` values |
| `permission denied` reading the config | The `cloudflared` user cannot read our files | Re-run the two `chown` commands in [[04 - Isolated Cloudflare Tunnel]] Part F |
| `address already in use` | The metrics port clashes | Change `metrics:` to another free port; `sudo ss -ltnp \| grep 20253` |
| `failed to parse ingress` | YAML error | `cloudflared --config /etc/cloudflared/monocle-lens.yml tunnel ingress validate` |
| `Cannot determine default origin certificate path` | The unit is resolving the tunnel **by name** after `cert.pem` was removed | Drop the tunnel name from `ExecStart` — see [[04 - Isolated Cloudflare Tunnel]] Part F Step 2 |

### Error 1033 / "Argo Tunnel error" in the browser

The tunnel is not connected.

```bash
sudo systemctl status cloudflared-monocle-lens --no-pager
curl -s http://127.0.0.1:20253/ready; echo   # the process's own view — no cert needed
cloudflared tunnel info monocle-lens          # Cloudflare's view — needs ~/.cloudflared/cert.pem
sudo systemctl restart cloudflared-monocle-lens
```

### Error 502 after the edge accepts the request

The tunnel is up but the origin is not answering on the configured address.

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3100/     # must be 200
docker compose ps
sudo grep 'service: http' /etc/cloudflared/monocle-lens.yml         # must match the real port
```

### Error 524 — the origin took too long

Cloudflare gives the origin 100 seconds to send its **first byte**. Normal Lens traffic never hits this: `/api/chat` emits events immediately. If you see it, the backend is stuck rather than slow:

```bash
make logs                                   # is the run progressing?
docker stats --no-stream lens_backend       # CPU/memory pressure on the Pi
```

### The app works but responses arrive all at once, not streamed

Something is buffering. Confirm you have **not** put the host Nginx in front of the tunnel — the supported path is tunnel → `127.0.0.1:3100` directly ([[01 - Pi Survey and Prerequisites]] Part A Step 2).

```bash
ps -ef | grep -- '[c]loudflared'            # our process points at monocle-lens.yml
```

### I think I disturbed another app's tunnel

Check, then restore:

```bash
systemctl list-units --type=service 'cloudflared*' --no-pager
sudo systemctl status cloudflared --no-pager
sudo systemctl cat cloudflared --no-pager | head -20     # does it still name its own config?
cloudflared tunnel list                                   # are all tunnels still present?
curl -I https://zoelibrary.unismartsolutions.co.za
```

If `cloudflared.service` was overwritten by an accidental `cloudflared service install`, restore its `ExecStart` to point at that app's own config file, then `sudo systemctl daemon-reload && sudo systemctl restart cloudflared`.

### DNS does not resolve

```bash
dig +short monocle-interview-prep-tevin-richard.unismartsolutions.co.za
```

Expect Cloudflare IPs. Nothing returned means the route was never created:

```bash
cloudflared tunnel route dns monocle-lens monocle-interview-prep-tevin-richard.unismartsolutions.co.za
```

(Needs `~/.cloudflared/cert.pem` — restore it temporarily if you removed it.)

---

## 🟪 Stage 4 — Cloudflare Access

### Login loop, or "You do not have access"

Your email is not on the Allow policy. Zero Trust → **Access → Applications → Monocle Lens → Policies**.

### An interviewer cannot reach the page at all

Expected if Access is on and they are not on the policy. Add their email, or see the demo-day decision box in [[05 - Cloudflare Access and Hardening]].

### `curl -I` returns 200 instead of 302

Access is not actually in front of the hostname. Check the application's **Public hostname** — subdomain `monocle-interview-prep-tevin-richard`, domain `unismartsolutions.co.za`, path empty.

---

## 🟩 Stage 5 — Entra Sign-In

### `AADSTS50011: The redirect URI ... does not match`

The production URL is missing from the registration, or has a trailing slash.

Portal → **App registrations → Lens → Authentication → Single-page application**. It must contain **exactly**:

```
https://monocle-interview-prep-tevin-richard.unismartsolutions.co.za
```

No trailing slash. See [[02 - Secrets, Entra and the Domain]] Part C.

### `AADSTS9002326: Cross-origin token redemption is permitted only for the 'Single-Page Application' client-type`

The URI is registered under the **Web** platform instead of **Single-page application**. Remove it from Web, add it under SPA.

### Sign-in succeeds at Microsoft, then Lens refuses

The account is not assigned to the enterprise application.

Portal → **Enterprise applications → Lens → Users and groups → Add user/group**.

### Every API call returns 401 after a successful sign-in

```bash
make check-auth              # validates against your tenant's live signing keys
docker compose logs --tail=50 backend | grep -i -E 'token|auth|401'
```

Usually a mismatch between `LENS-ENTRA-SPA-CLIENT-ID` in the vault and the registration actually being signed into, or `requestedAccessTokenVersion` not set to `2` — see **[ENTRA_SETUP.md](ENTRA_SETUP.md)**.

### The welcome dialog greets me without a name

Harmless: Entra did not return a `given_name` claim for that account, so the greeting drops the name rather than guessing. Sign-in and every other function are unaffected.

---

## 🧾 Evidence to Collect Before Asking for Help

```bash
{
  echo "=== containers ==="   ; docker ps -a --filter name=lens_ --format '{{.Names}}\t{{.Status}}'
  echo "=== health ==="       ; curl -s http://127.0.0.1:5100/api/health
  echo "=== ports ==="        ; sudo ss -ltnp | grep -E '3100|5100|5439|20253'
  echo "=== tunnels ==="      ; systemctl list-units --type=service 'cloudflared*' --no-pager
  echo "=== our tunnel ==="   ; sudo journalctl -u cloudflared-monocle-lens -n 30 --no-pager
  echo "=== ingress ==="      ; sudo grep -v 'credentials-file' /etc/cloudflared/monocle-lens.yml
  echo "=== dns ==="          ; dig +short monocle-interview-prep-tevin-richard.unismartsolutions.co.za
  echo "=== public ==="       ; curl -sI https://monocle-interview-prep-tevin-richard.unismartsolutions.co.za | head -3
} 2>&1 | tee ~/lens-diagnostics.txt
```

> ⚠️ Warning: Check that file before sharing it. The `credentials-file` line is filtered above, but skim for anything else you would not want to paste in public.

---

> **Back to:** [[00 - Monocle Lens Pi Deployment Home]]
