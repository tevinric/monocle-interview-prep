# 04 — Isolated Cloudflare Tunnel

> **Your domain:** `monocle-interview-prep-tevin-richard.unismartsolutions.co.za` (zone `unismartsolutions.co.za`, registered at 1Grid, served through Cloudflare)
>
> **Navigation:** [[00 - Monocle Lens Pi Deployment Home]] | Prev: [[03 - Deploy the Stack on the Pi]] | Next: [[05 - Cloudflare Access and Hardening]]

---

## 🎯 Goal of This Step

A **second, completely independent** Cloudflare Tunnel on a Pi that already runs one or more. By the end:

- A tunnel named `monocle-lens` with its own credentials
- Its own config file — the existing `/etc/cloudflared/config.yml` is never opened
- Its own systemd unit — `cloudflared.service` is never edited or restarted
- Its own metrics port — no fight over a shared listener
- Lens live at `https://monocle-interview-prep-tevin-richard.unismartsolutions.co.za`
- **Every other app on the Pi still up, having never noticed**

---

## 🚨 The One Command You Must Not Run

```bash
sudo cloudflared service install        # ❌ NEVER on a multi-tunnel host
```

**What it does:** writes `/etc/systemd/system/cloudflared.service`, hard-wired to the *default* config path `/etc/cloudflared/config.yml`, and starts it.

**Why that is destructive here:** your existing app's tunnel is almost certainly already using that unit and that config file. Running the installer again **overwrites the unit**, restarts it, and — depending on which config it picks up — can take your other site offline or leave two processes fighting over one tunnel's connections.

Everything below uses an explicit `--config` path and a **separately named unit**, which is the supported way to run multiple tunnels from one host.

> 💡 Tip: If you have ever run `cloudflared service install` on this Pi for another app, that is fine and normal — leave it exactly as it is. We simply add a second unit beside it.

---

## 🧭 Part A — Re-confirm the Existing Setup

You captured this in [[01 - Pi Survey and Prerequisites]]. Confirm it once more, immediately before changing anything, and keep the output.

```bash
# 1. Which cloudflared services exist, and are they healthy?
systemctl list-units --type=service --all 'cloudflared*' --no-pager

# 2. What is in the shared config directory?
sudo ls -la /etc/cloudflared/

# 3. What does the existing unit actually run? (READ ONLY — do not edit)
sudo systemctl cat cloudflared --no-pager 2>/dev/null | head -40

# 4. Which tunnels does this Cloudflare account already have?
cloudflared tunnel list

# 5. Are the existing tunnels connected right now?
sudo systemctl is-active cloudflared 2>/dev/null
```

**Write down:**

| Question | Your answer |
|---|---|
| Existing service unit name(s) | e.g. `cloudflared.service` |
| Existing config file path(s) | e.g. `/etc/cloudflared/config.yml` |
| Existing tunnel name(s) and UUID(s) | from `cloudflared tunnel list` |
| Any `metrics:` port already set | `grep -i metrics` the existing config |
| Which user the existing service runs as | from `systemctl cat` |

```bash
# Check for an existing metrics port so we do not collide
sudo grep -i 'metrics' /etc/cloudflared/*.yml 2>/dev/null || echo "no explicit metrics port configured"
sudo ss -ltnp | grep -i cloudflared || echo "no cloudflared listeners bound"
```

> ⚠️ Warning: If a metrics port is already bound (commonly `127.0.0.1:20241`), **do not** reuse it. We use `127.0.0.1:20253`. If that is taken too, pick another free high port and substitute it consistently below.

---

## 📥 Part B — Install or Update `cloudflared`

If [[01 - Pi Survey and Prerequisites]] found `cloudflared` already installed, **skip to Part C** — your other tunnels depend on this binary and there is no reason to touch it.

Only if it is missing:

```bash
curl -L -o cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64.deb
sudo dpkg -i cloudflared.deb
rm cloudflared.deb
cloudflared --version
```

> ⚠️ Warning: Do not casually run `sudo cloudflared update` on a shared host to "get the latest". A binary upgrade restarts **every** tunnel service on the machine. If you do need it, schedule it and check each app afterwards.

---

## 🔑 Part C — Authenticate and Create the Tunnel

### Step 1 — Do you already have an account certificate?

```bash
ls -la ~/.cloudflared/cert.pem 2>/dev/null && echo "cert present" || echo "cert absent — log in below"
```

If the certificate is present (from setting up an earlier tunnel) you can skip the login. If you removed it as a hardening step, restore it temporarily or log in again:

```bash
cloudflared tunnel login
```

Open the printed URL, sign in, and **select the `unismartsolutions.co.za` zone**. This writes `~/.cloudflared/cert.pem`.

> ⚠️ Warning: `cert.pem` can manage tunnels and DNS for that zone. It is needed only to **create or change** tunnels — never to **run** one. Part G removes it again.

### Step 2 — Create the tunnel

```bash
cloudflared tunnel create monocle-lens
```

Output ends with something like:

```
Created tunnel monocle-lens with id 8c1d4b7e-2f93-4a6c-b0d1-77e5a9c3f214
```

**Copy that UUID.** It is also the name of the credentials file now sitting in `~/.cloudflared/`.

```bash
# Confirm — your existing tunnels must still be listed alongside the new one
cloudflared tunnel list
```

Expected: your previous tunnel(s) **and** `monocle-lens`. Nothing disappeared.

Capture the UUID into a shell variable to make the rest of this page copy-pasteable:

```bash
TUNNEL_ID=$(cloudflared tunnel list --output json | python3 -c "import sys,json;print([t['id'] for t in json.load(sys.stdin) if t['name']=='monocle-lens'][0])")
echo "$TUNNEL_ID"
```

> 💡 Tip: If that one-liner is not to your taste, just read the UUID from `cloudflared tunnel list` and `export TUNNEL_ID=<uuid>` by hand. Every command below uses `$TUNNEL_ID`.

---

## 📝 Part D — Its Own Config, Its Own Credentials

### Step 1 — Copy **only our** credentials file into place

```bash
sudo mkdir -p /etc/cloudflared
sudo cp ~/.cloudflared/${TUNNEL_ID}.json /etc/cloudflared/
sudo chmod 600 /etc/cloudflared/${TUNNEL_ID}.json
sudo ls -la /etc/cloudflared/
```

> ⚠️ Warning: Copy the **one** file named after your new UUID, by name. A wildcard `sudo cp ~/.cloudflared/* /etc/cloudflared/` would also copy `cert.pem` — an account-wide credential that can manage every tunnel and DNS record on the zone — into a directory another application reads from, and would overwrite any same-named file already there. One file, named explicitly.

### Step 2 — Write the Lens config under its own name

```bash
sudo nano /etc/cloudflared/monocle-lens.yml
```

Paste this, replacing **both** `<TUNNEL-ID>` placeholders with your UUID:

```yaml
# =============================================================================
# Cloudflare Tunnel — Monocle Lens
# =============================================================================
# This file belongs to the monocle-lens tunnel ONLY. Other applications on this
# Pi have their own config files in this directory; none of them read this one,
# and this one reads none of theirs. Run it with:
#
#   cloudflared --config /etc/cloudflared/monocle-lens.yml tunnel run
#
# No tunnel name is passed on the command line: the `tunnel:` UUID below plus the
# credentials file are enough, and that keeps the service independent of
# ~/.cloudflared/cert.pem, which Part G removes.
# =============================================================================

tunnel: <TUNNEL-ID>
credentials-file: /etc/cloudflared/<TUNNEL-ID>.json

# Never self-update: an upgrade would restart this process, and on a shared host
# updates are a scheduled decision, not a background surprise.
no-autoupdate: true
loglevel: info

# A DEDICATED metrics port. cloudflared binds one per process; leaving this to
# chance is how a second tunnel ends up fighting the first for a listener.
metrics: 127.0.0.1:20253

# Ingress rules match top to bottom. Lens's own nginx (inside lens_frontend)
# proxies /api to the backend internally, so ONE rule is all that is needed —
# the API and the database are never addressed from here.
ingress:
  - hostname: monocle-interview-prep-tevin-richard.unismartsolutions.co.za
    service: http://127.0.0.1:3100
    originRequest:
      # /api/chat and /api/evals/run stream Server-Sent Events for the length of
      # an agent run — minutes, in the case of an evaluation batch. cloudflared
      # streams rather than buffers, so nothing needs disabling here; what matters
      # is that the pooled connection is allowed to stay open while the agent
      # reasons. gunicorn's own ceiling is 300s, so match it.
      connectTimeout: 30s
      keepAliveTimeout: 300s
      keepAliveConnections: 10

  # Catch-all: anything not matched above is refused outright.
  - service: http_status:404
```

Save with `Ctrl+X`, `Y`, `Enter`.

If you pasted the block with the placeholders still in it, substitute them now — and either way, check the result:

```bash
sudo sed -i "s|<TUNNEL-ID>|${TUNNEL_ID}|g" /etc/cloudflared/monocle-lens.yml
sudo grep -n "tunnel:\|credentials-file:\|metrics:\|service: http" /etc/cloudflared/monocle-lens.yml
```

Expected: a real UUID on the `tunnel:` line, the matching `.json` path, `127.0.0.1:20253`, and `http://127.0.0.1:3100` — no `<TUNNEL-ID>` left anywhere.

Validate the file before going further:

```bash
cloudflared --config /etc/cloudflared/monocle-lens.yml tunnel ingress validate
```

Expected: `Validating rules from /etc/cloudflared/monocle-lens.yml` … `OK`.

Test that the rule resolves to the right origin:

```bash
cloudflared --config /etc/cloudflared/monocle-lens.yml tunnel ingress rule \
  https://monocle-interview-prep-tevin-richard.unismartsolutions.co.za/audit
```

Expected: matched rule **0**, service `http://127.0.0.1:3100`.

> 💡 Tip: If you chose a different frontend port in [[01 - Pi Survey and Prerequisites]] Part D, change `http://127.0.0.1:3100` here to match. This is the **only** place the port appears in the tunnel layer.

> 💡 Tip: Cloudflare's edge gives an origin **100 seconds to send its first byte** before returning error 524. Lens is safe by design — `/api/chat` emits its `run` and `step` events the moment the agent starts, long before the answer is written — but it is the reason a *non-streaming* long operation would fail through the tunnel while working fine on loopback. See [[07 - Troubleshooting]].

**Why this config is safe for the other apps:**

| Property | Effect |
|---|---|
| Its own filename | The existing `config.yml` is never read, written or reloaded |
| Its own `credentials-file` | Points at our UUID; another tunnel's credentials are untouched |
| Its own `metrics` port | No contention with an existing metrics listener |
| One `hostname` rule | Only this subdomain is served; another app's hostname would 404 here |
| `http_status:404` catch-all | The tunnel cannot be coaxed into proxying anything else on the Pi — not the database on `5439`, not the API on `5100`, not another app on `3002` |

---

## 🌍 Part E — Route the Domain to This Tunnel

```bash
cloudflared tunnel route dns monocle-lens monocle-interview-prep-tevin-richard.unismartsolutions.co.za
```

This adds a **proxied CNAME** (`monocle-interview-prep-tevin-richard` → `<TUNNEL-ID>.cfargotunnel.com`) to the `unismartsolutions.co.za` zone. It creates **one new record** and alters none of the existing ones.

Verify from anywhere:

```bash
dig +short monocle-interview-prep-tevin-richard.unismartsolutions.co.za
```

Expected: Cloudflare edge IPs (e.g. `104.21.x.x`, `172.67.x.x`) — which is what "proxied" looks like. Not your Pi's IP; that is the point.

> ⚠️ Warning: If the command reports that the record already exists, check in the Cloudflare dashboard (**DNS → Records**) what it points at before overwriting. Use `--overwrite-dns` **only** once you are certain the existing record is not another app's.

### Test in the foreground, before installing any service

```bash
sudo cloudflared --config /etc/cloudflared/monocle-lens.yml tunnel run
```

Leave it running. You should see `Registered tunnel connection` lines (usually four). Now, from your laptop:

```bash
curl -I https://monocle-interview-prep-tevin-richard.unismartsolutions.co.za
```

Expected: `HTTP/2 200` (Cloudflare Access is not configured yet — that is [[05 - Cloudflare Access and Hardening]]).

Open it in a browser. You should reach the Lens sign-in page over HTTPS, and signing in with your Entra account should now work — because you added this exact origin as a redirect URI in [[02 - Secrets, Entra and the Domain]].

**While it is running, confirm the other apps are unaffected:**

```bash
# In a SECOND ssh session
sudo systemctl is-active cloudflared        # existing service: still "active"
curl -I https://zoelibrary.unismartsolutions.co.za   # or whatever else you host
```

Press `Ctrl+C` in the first session to stop the foreground test.

---

## ⚙️ Part F — Its Own systemd Service

### Step 1 — The `cloudflared` system user

If an existing tunnel service already runs as a `cloudflared` user, reuse it. Otherwise create it:

```bash
id cloudflared >/dev/null 2>&1 \
  && echo "user exists — reuse it" \
  || sudo useradd --system --no-create-home --shell /usr/sbin/nologin cloudflared
```

Grant that user access to **our two files only** — never `chown -R` the shared directory:

```bash
sudo chown cloudflared:cloudflared /etc/cloudflared/monocle-lens.yml
sudo chown cloudflared:cloudflared /etc/cloudflared/${TUNNEL_ID}.json
sudo chmod 600 /etc/cloudflared/${TUNNEL_ID}.json
sudo chmod 644 /etc/cloudflared/monocle-lens.yml

# The directory itself must be traversable by the cloudflared user
stat -c '%a %U:%G %n' /etc/cloudflared        # check BEFORE changing anything
sudo chmod 755 /etc/cloudflared               # only if it is not already 755
sudo ls -la /etc/cloudflared/
```

> 💡 Tip: `chmod 755` on the *directory* is the one change in this guide that touches a shared path. It is safe: directory permissions govern traversal and listing, not file contents. Another app's credentials file stays `600` and root-owned, so it remains unreadable. If the directory is already `755` — it usually is — skip the command entirely.

> ⚠️ Warning: A blanket `sudo chown -R cloudflared:cloudflared /etc/cloudflared` appears in many tunnel walkthroughs (including the Zoe Library one, where the Pi hosted a single tunnel). On a **shared** host it rewrites the ownership of another application's credentials. Chown the two files by name, as above.

### Step 2 — Write the dedicated unit

```bash
sudo nano /etc/systemd/system/cloudflared-monocle-lens.service
```

```ini
[Unit]
Description=Cloudflare Tunnel — Monocle Lens (isolated; does not touch cloudflared.service)
Documentation=https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
User=cloudflared
Group=cloudflared

# The --config flag is what keeps this process bound to the Monocle Lens tunnel
# and blind to every other config file in /etc/cloudflared. No tunnel NAME is
# passed: the config's `tunnel:` UUID and credentials file identify it, so the
# service keeps working after cert.pem is removed in Part G.
ExecStart=/usr/bin/cloudflared --no-autoupdate --config /etc/cloudflared/monocle-lens.yml tunnel run

Restart=on-failure
RestartSec=5s
TimeoutStartSec=0

# Hardening — the tunnel makes outbound connections and reaches one loopback
# port. It never needs anything else on this machine.
NoNewPrivileges=true
ProtectHome=true
ProtectSystem=full
PrivateTmp=true
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictNamespaces=true

[Install]
WantedBy=multi-user.target
```

Save and exit.

### Step 3 — Enable and start **only** this unit

```bash
sudo systemctl daemon-reload
sudo systemctl enable cloudflared-monocle-lens
sudo systemctl start cloudflared-monocle-lens
sudo systemctl status cloudflared-monocle-lens --no-pager
```

Expected: `active (running)`, with the `Main PID` owned by `cloudflared`.

> ⚠️ Warning: Note what you did **not** type: no `systemctl restart cloudflared`, no `daemon-reload` side-effects on other units (a reload re-reads unit files but does not restart running services), and no edit of any existing file.

### Step 4 — Prove both tunnels coexist

```bash
# Both services active
systemctl list-units --type=service 'cloudflared*' --no-pager

# Two distinct processes. Ours is the one carrying --config .../monocle-lens.yml;
# the pre-existing one runs however it always did.
ps -ef | grep -- '[c]loudflared'

# Our metrics port is ours alone
sudo ss -ltnp | grep 20253

# Cloudflare's own view of each tunnel (these two call the API, so they need
# ~/.cloudflared/cert.pem — which you still have at this point in the guide)
cloudflared tunnel info monocle-lens
cloudflared tunnel list

# A check that needs no cert at all: our process's own metrics endpoint
curl -s http://127.0.0.1:20253/ready; echo
```

Expected: your existing tunnel and `monocle-lens` both showing healthy connector(s), each process carrying a different `--config` path.

```bash
# And the other sites still answer
curl -I https://zoelibrary.unismartsolutions.co.za
curl -I https://monocle-interview-prep-tevin-richard.unismartsolutions.co.za
```

---

## 🔒 Part G — Remove the Account Certificate (Optional Hardening)

`~/.cloudflared/cert.pem` is needed only to create or change tunnels and DNS routes — not to run them. Once everything works:

```bash
# Copy it somewhere safe FIRST (password manager / offline storage), then:
rm ~/.cloudflared/cert.pem
```

While it is gone, the **management** commands — `cloudflared tunnel create`, `route`, `delete`, `list` and `info` — will not work, because they call Cloudflare's API. Restore the file temporarily whenever you need one of them.

> 💡 Tip: The **running** services are unaffected: they authenticate with the per-tunnel JSON credentials in `/etc/cloudflared` and are identified by the `tunnel:` UUID in their own config. This is exactly why the unit above runs `tunnel run` with no name argument — resolving a tunnel *by name* is an API lookup that would need `cert.pem`, and the service would fail to start after this step.

---

## 🔁 Part H — Reboot Test

```bash
sudo reboot
```

Wait ~60 seconds, reconnect, then:

```bash
# The tunnel came back on its own
sudo systemctl status cloudflared-monocle-lens --no-pager

# Your other tunnel did too
sudo systemctl status cloudflared --no-pager

# The app came back (restart: unless-stopped, plus a persisted secrets volume)
cd /home/reunionparadise/sites/monocle-interview-prep/monocle-lens/lens
docker compose ps

# End to end
curl -I https://monocle-interview-prep-tevin-richard.unismartsolutions.co.za

# The tunnel's own connector count, straight from the process (no API, no cert.pem)
curl -s http://127.0.0.1:20253/metrics | grep -c '^cloudflared_tunnel_ha_connections' \
  && echo "metrics endpoint answering"
```

> 💡 Tip: Lens survives a reboot without you re-sourcing the vault script, because `lens_db`, `lens_backend` and `lens_frontend` carry `restart: unless-stopped` and the `lens_secrets` volume persists. You only need `source ./lens_kv_init.sh` again when you run a `docker compose` command yourself. [[06 - Operations, Updates and Reboots]] explains exactly where that line is.

---

## 🧯 If Something Goes Wrong — Instant Rollback

This tunnel can be removed without leaving a trace, and without touching anything else:

```bash
sudo systemctl disable --now cloudflared-monocle-lens
sudo rm /etc/systemd/system/cloudflared-monocle-lens.service
sudo systemctl daemon-reload

sudo rm /etc/cloudflared/monocle-lens.yml
sudo rm /etc/cloudflared/${TUNNEL_ID}.json

# Needs cert.pem present
cloudflared tunnel delete monocle-lens
# Then delete the CNAME record in the Cloudflare dashboard → DNS → Records
```

Your other tunnels are untouched throughout — different unit, different config, different credentials.

---

## ✅ Checklist

- [ ] `sudo cloudflared service install` was **never** run
- [ ] `/etc/cloudflared/config.yml` was never opened for editing
- [ ] `cloudflared.service` was never edited or restarted
- [ ] Tunnel `monocle-lens` created; existing tunnels still listed
- [ ] `/etc/cloudflared/monocle-lens.yml` exists, validates, and resolves to `127.0.0.1:3100`
- [ ] Dedicated metrics port `127.0.0.1:20253` bound by our process only
- [ ] Only our two files were chowned to `cloudflared`
- [ ] `cloudflared-monocle-lens.service` is `active (running)` and enabled
- [ ] `ps -ef` shows two cloudflared processes with different `--config` paths
- [ ] The other app's domain still answers `200`
- [ ] `https://monocle-interview-prep-tevin-richard.unismartsolutions.co.za` serves Lens over HTTPS
- [ ] Entra sign-in succeeds on the new domain
- [ ] Both tunnels and the app return after a reboot

---

> **Next Step:** [[05 - Cloudflare Access and Hardening]] — put an identity wall in front of the app at Cloudflare's edge, and decide how demo day works.
