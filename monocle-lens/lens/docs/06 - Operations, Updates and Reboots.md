# 06 — Operations, Updates and Reboots

> **Navigation:** [[00 - Monocle Lens Pi Deployment Home]] | Prev: [[05 - Cloudflare Access and Hardening]] | Next: [[07 - Troubleshooting]]

---

## 🎯 Goal of This Section

The day-two cheat sheet: starting, stopping, updating, reading logs, what survives a reboot, and how to remove the whole deployment cleanly if you ever need to.

---

## ⚡ The Commands You'll Use Most

Every app command assumes:

```bash
cd /home/reunionparadise/sites/monocle-interview-prep/monocle-lens/lens
```

| Task | Command |
|------|---------|
| Start everything | `source ./lens_kv_init.sh && make up` |
| Stop everything (data kept) | `make down` |
| Service status | `docker compose ps` |
| Follow the API log | `make logs` |
| Follow all logs | `docker compose logs -f` |
| Restart one service | `docker compose restart backend` |
| Backend health | `curl -s http://127.0.0.1:5100/api/health` |
| Open a DB shell | `make psql` |
| Re-ingest the corpus | `make ingest` |
| Re-seed demo history | `make seed` |
| Score the question set | `make eval` |
| **Tunnel status** | `sudo systemctl status cloudflared-monocle-lens --no-pager` |
| **Tunnel logs** | `sudo journalctl -u cloudflared-monocle-lens -f` |
| **Tunnel restart** | `sudo systemctl restart cloudflared-monocle-lens` |
| **Tunnel health at Cloudflare** | `cloudflared tunnel info monocle-lens` *(needs `cert.pem`)* |
| **Tunnel health, no cert needed** | `curl -s http://127.0.0.1:20253/ready` |

> ⚠️ Warning: Never `docker compose down -v`. The `-v` deletes `lens_pg_data` — every trace, run, conversation and embedding — and `lens_secrets`. A re-`make up` would then need a full `make ingest` again.

> ⚠️ Warning: Never `sudo systemctl restart cloudflared` (no suffix). That is **another application's** tunnel. Ours always carries `-monocle-lens`.

---

## 🔄 What Happens on a Reboot

Nothing is required of you. Here is why, and where the one catch is:

| Component | Comes back automatically? | Mechanism |
|---|---|---|
| `lens_db`, `lens_backend`, `lens_frontend` | ✅ Yes | `restart: unless-stopped` + Docker enabled at boot |
| `lens_keyvault_init` | ✅ Stays exited — correct | `restart: "no"`; its secrets already sit on the `lens_secrets` volume, which persists |
| Database contents | ✅ Yes | `lens_pg_data` named volume |
| The tunnel | ✅ Yes | `cloudflared-monocle-lens.service` is `enabled` |
| Your shell's four vault variables | ❌ No | `source` affects one shell only |

**The catch:** after a reboot your SSH session has no `LENS_AZURE_*` variables, so any `docker compose` / `make` command that has to interpolate them fails loudly:

```
required variable LENS_AZURE_KEYVAULT_URL is missing a value
```

That is the design working — it refuses to start the stack half-configured. The fix is one line:

```bash
cd /home/reunionparadise/sites/monocle-interview-prep/monocle-lens/lens
source ./lens_kv_init.sh
```

> 💡 Tip: The running app does not care. The variables are needed to *start or rebuild* containers, not to keep them running. A rebooted Pi serves Lens happily with no one logged in.

### Optional — start the stack from systemd instead

Only worth it if you want a **full `compose up`** (not just container restarts) at boot — for example so `keyvault-init` re-fetches secrets every time and picks up a rotated key.

```bash
# The four variables, root-owned, for systemd only
sudo mkdir -p /etc/lens
sudo tee /etc/lens/kv.env >/dev/null <<'ENVFILE'
LENS_AZURE_KEYVAULT_URL=https://<your-vault-name>.vault.azure.net/
LENS_AZURE_TENANT_ID=<tenant-guid>
LENS_AZURE_CLIENT_ID=<service-principal-app-id>
LENS_AZURE_CLIENT_SECRET=<service-principal-secret-value>
ENVFILE
sudo chmod 600 /etc/lens/kv.env
sudo chown root:root /etc/lens/kv.env
```

> ⚠️ Warning: This file is an unencrypted copy of the vault credentials. `chmod 600` and root ownership are not optional. If you are not comfortable with that, skip this section — the default behaviour already survives reboots.

```bash
sudo nano /etc/systemd/system/lens-stack.service
```

```ini
[Unit]
Description=Monocle Lens — docker compose stack
Requires=docker.service
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=true
WorkingDirectory=/home/reunionparadise/sites/monocle-interview-prep/monocle-lens/lens
EnvironmentFile=/etc/lens/kv.env
ExecStart=/usr/bin/docker compose up -d
ExecStop=/usr/bin/docker compose down
TimeoutStartSec=0

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable lens-stack
sudo systemctl start lens-stack
sudo systemctl status lens-stack --no-pager
```

> 💡 Tip: This unit is independent of `cloudflared-monocle-lens.service` and of every other app's units. If the stack is slow to start, the tunnel simply returns 502 until it is up, then recovers by itself.

---

## 📦 Deploying a Code Change

### Step 1 — Get the new code onto the Pi

```bash
# From your LAPTOP — same excludes as the first time
rsync -avz --delete \
  --exclude '.git/' --exclude 'node_modules/' --exclude 'dist/' \
  --exclude '__pycache__/' --exclude 'corpus/raw/' \
  --exclude '.env' --exclude 'lens_kv_init.sh' \
  ~/Desktop/Github/monocle-interview-prep/ \
  reunionparadise@<pi-ip>:~/sites/monocle-interview-prep/
```

Or, if you cloned: `cd ~/sites/monocle-interview-prep && git pull`.

### Step 2 — Rebuild and restart

```bash
cd /home/reunionparadise/sites/monocle-interview-prep/monocle-lens/lens
source ./lens_kv_init.sh
make up                                  # rebuilds what changed, restarts it
docker compose ps
curl -s http://127.0.0.1:5100/api/health
```

The tunnel needs **nothing**. It points at a port, not a container, and reconnects to the new frontend by itself within a second or two.

### Rebuilding a single service

```bash
docker compose up -d --build frontend    # UI-only change
docker compose up -d --build backend     # API-only change
```

### Changes that need no rebuild at all

| Change | What to do |
|---|---|
| A prompt file under `backend/lens/agent/prompts/` | Nothing — it is bind-mounted. Edit and hit **Replay** in the app. |
| A value in `.env` | `docker compose up -d --force-recreate backend` |
| A rotated Key Vault secret | `docker compose up -d --force-recreate keyvault-init backend` |

> 💡 Tip: Changing a prompt changes the prompt-bundle hash, which is recorded on every subsequent run. That is the point — open an old trace and use *Re-run against current prompts* to see exactly what moved.

---

## 🩺 Routine Health Check

A single paste that tells you whether the whole path is healthy:

```bash
echo "── containers ──"      && docker ps --filter name=lens_ --format 'table {{.Names}}\t{{.Status}}'
echo "── api ──"             && curl -s http://127.0.0.1:5100/api/health; echo
echo "── frontend ──"        && curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3100/
echo "── tunnel service ──"  && systemctl is-active cloudflared-monocle-lens
echo "── tunnel ready ──"    && curl -s http://127.0.0.1:20253/ready; echo
echo "── other tunnels ──"   && systemctl is-active cloudflared 2>/dev/null
echo "── public url ──"      && curl -s -o /dev/null -w '%{http_code}\n' https://monocle-interview-prep-tevin-richard.unismartsolutions.co.za
echo "── exposure ──"        && sudo ss -ltnp | grep -E '3100|5100|5439'
```

Healthy looks like: four containers up (one `Exited (0)`), `"auth":"entra"`, `200`, `active`, `active`, `302`-or-`200`, and three `127.0.0.1:` lines.

---

## 💾 Backups

The database holds every trace, run and embedding. Corpus source files can always be re-fetched with `make ingest`; the traces cannot.

```bash
cd /home/reunionparadise/sites/monocle-interview-prep/monocle-lens/lens
mkdir -p ~/backups/lens

docker compose exec -T postgres sh -c \
  'pg_dump -U "$(cat /secrets/parts/LENS-DB-USER)" -d "$(cat /secrets/parts/LENS-DB-NAME)"' \
  | gzip > ~/backups/lens/lens-$(date +%F-%H%M).sql.gz

ls -lh ~/backups/lens/
```

Restore into a running stack:

```bash
gunzip -c ~/backups/lens/lens-2026-09-17-1200.sql.gz | \
  docker compose exec -T postgres sh -c \
  'psql -U "$(cat /secrets/parts/LENS-DB-USER)" -d "$(cat /secrets/parts/LENS-DB-NAME)"'
```

> ⚠️ Warning: **Never back up the `lens_secrets` volume.** It holds plaintext credentials fetched from the vault. If you adapt the Zoe Library rclone job for this app, exclude it explicitly — the vault is the source of truth and the volume is rebuilt on every online start.

> 💡 Tip: To reuse the Zoe Library Google Drive schedule, point a copy of that script at the command above and give it its own cron line and its own remote folder. Two apps, two jobs, no shared state.

---

## 🧹 Removing the Deployment Completely

In this order, nothing else on the Pi is affected:

```bash
# 1. The app
cd /home/reunionparadise/sites/monocle-interview-prep/monocle-lens/lens
source ./lens_kv_init.sh
make down
docker volume rm lens_pg_data lens_secrets     # ⚠️ destroys all traces
docker network rm lens_net 2>/dev/null

# 2. The optional stack unit, if you created it
sudo systemctl disable --now lens-stack 2>/dev/null
sudo rm -f /etc/systemd/system/lens-stack.service /etc/lens/kv.env

# 3. The tunnel — ours only
sudo systemctl disable --now cloudflared-monocle-lens
sudo rm -f /etc/systemd/system/cloudflared-monocle-lens.service
sudo systemctl daemon-reload
sudo rm -f /etc/cloudflared/monocle-lens.yml
sudo rm -f /etc/cloudflared/<TUNNEL-ID>.json
cloudflared tunnel delete monocle-lens          # needs cert.pem present

# 4. The code
rm -rf /home/reunionparadise/sites/monocle-interview-prep
```

Then, in the Cloudflare dashboard: delete the `monocle-interview-prep-tevin-richard` CNAME record and the **Monocle Lens** Access application. In Azure, remove the production redirect URI from the Lens app registration.

> ⚠️ Warning: Step 3 names files individually on purpose. `sudo rm /etc/cloudflared/*` would delete another application's tunnel credentials.

---

## ✅ Checklist

- [ ] You know the difference between `cloudflared-monocle-lens` (ours) and `cloudflared` (theirs)
- [ ] You know that `source ./lens_kv_init.sh` is needed per shell, not per boot
- [ ] Redeploy path tested once: rsync → `make up` → health check
- [ ] A database backup has been taken and the restore command read
- [ ] `lens_secrets` excluded from any backup job
- [ ] The removal procedure is understood as file-by-file, never wildcard

---

> **Next Step:** [[07 - Troubleshooting]] — what each failure looks like, and the command that identifies it.
