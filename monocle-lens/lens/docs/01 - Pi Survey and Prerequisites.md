# 01 — Pi Survey and Prerequisites

> **Navigation:** [[00 - Monocle Lens Pi Deployment Home]] | Next: [[02 - Secrets, Entra and the Domain]]

---

## 🎯 Goal of This Step

By the end of this page you will have **written down exactly what the Pi already runs**, proved that Lens collides with none of it, and placed the application code on the Pi ready to build.

This is the most important page in the guide. Everything that could break another application is decided here.

---

## 🩺 Part A — Survey the Pi Before Changing Anything

SSH into the Pi and run every command below. **Keep the output** — paste it into a scratch note. You are building a "before" picture so that, later, you can prove nothing moved.

```bash
ssh reunionparadise@<pi-ip-or-hostname>
```

### Step 1 — What is listening, and on what?

```bash
sudo ss -ltnp
```

Read the `Local Address:Port` column. Note anything on **3100**, **5100** or **5439** — Lens's defaults. Note whether anything holds **:80** or **:443** (that will be a host Nginx or another reverse proxy).

Quick targeted check:

```bash
for p in 3100 5100 5439 20253; do
  echo -n "port $p: "
  sudo ss -ltn "sport = :$p" | grep -q LISTEN && echo "IN USE ⚠️" || echo "free ✅"
done
```

Expected: all four `free ✅`. Port `20253` is for the tunnel's metrics endpoint in [[04 - Isolated Cloudflare Tunnel]].

> ⚠️ Warning: If any port shows `IN USE`, **do not** stop whatever is using it. Pick different numbers in Part D of this page and carry them through the rest of the guide.

### Step 2 — Is there a host-level Nginx?

```bash
systemctl is-active nginx 2>/dev/null || echo "no host nginx service"
sudo nginx -t 2>/dev/null && echo "host nginx present and its config is currently valid"
ls -la /etc/nginx/sites-enabled/ 2>/dev/null
```

Whatever this reports, **Lens does not use it.** Lens ships its own Nginx *inside* the `lens_frontend` container, listening on port 80 *of that container only*, published to `127.0.0.1:3100` on the host. The tunnel connects straight to that loopback address.

| | Host Nginx | Lens's Nginx |
|---|---|---|
| Where it runs | On the Pi, as a systemd service | Inside the `lens_frontend` container |
| Binds | `:80` / `:443` on all interfaces | `:80` inside the container only |
| Reachable from host as | `http://<pi-ip>` | `http://127.0.0.1:3100` |
| Config files | `/etc/nginx/**` | Baked into the image from `frontend/nginx.conf` |
| Touched by this guide | **Never** | Never edited — only built |

> 💡 Tip: This is why the deployment cannot break your other sites. We add **zero** files under `/etc/nginx`, run **zero** `nginx -s reload`, and claim **neither** `:80` nor `:443`. If the host Nginx were to fall over tomorrow, Lens would stay up.

> ⚠️ Warning: Do **not** be tempted to "tidy things up" by putting Lens behind the host Nginx as well. `/api/chat` streams Server-Sent Events for the length of an agent run, and a default `proxy_buffering on` in a shared Nginx will hold the whole stream in a buffer and make the app look frozen. The tunnel → container path has no such problem, and it keeps the blast radius at zero.

### Step 3 — What Cloudflare tunnels already exist?

```bash
# Services (there may be one, several, or none)
systemctl list-units --type=service --all 'cloudflared*' --no-pager

# Existing config and credentials
ls -la /etc/cloudflared/ 2>/dev/null

# Is cloudflared installed at all, and which version?
cloudflared --version 2>/dev/null || echo "cloudflared NOT installed yet"
```

If a `cloudflared.service` exists, look at what it runs — without changing it:

```bash
sudo systemctl cat cloudflared --no-pager | head -40
```

**Write down:** the names of existing services, the existing config file paths, and any `metrics:` port they set. You will deliberately avoid all of them.

### Step 4 — What Docker names are taken?

```bash
docker ps -a --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
docker network ls
docker volume ls
```

Now prove the `lens_*` names are free:

```bash
for n in lens_keyvault_init lens_db lens_backend lens_frontend; do
  echo -n "container $n: "; docker ps -a --format '{{.Names}}' | grep -qx "$n" && echo "EXISTS ⚠️" || echo "free ✅"
done
echo -n "network lens_net: "; docker network ls --format '{{.Name}}' | grep -qx lens_net && echo "EXISTS ⚠️" || echo "free ✅"
for v in lens_pg_data lens_secrets; do
  echo -n "volume $v: "; docker volume ls --format '{{.Name}}' | grep -qx "$v" && echo "EXISTS ⚠️" || echo "free ✅"
done
```

Expected on a first deployment: every line `free ✅`. If you are **re-deploying**, `EXISTS` is normal and fine — those are your own objects from last time.

> 💡 Tip: Docker container, network and volume names are global to the daemon, which is why every Lens object is prefixed `lens_`. Nothing here is generic enough to collide with another app.

### Step 5 — Hardware headroom

```bash
free -h            # RAM and swap
df -h /            # disk space
nproc              # cores
uname -m           # expect: aarch64
cat /proc/device-tree/model 2>/dev/null; echo
```

**You need:** `aarch64` (64-bit OS), **≥ 6 GB free disk**, and ideally **4 GB RAM**. The frontend image builds a Vite bundle with Node, which is the memory-hungry step.

If you have 2 GB of RAM, add swap **before** building:

```bash
# Temporarily raise the swapfile to 2 GB (Raspberry Pi OS)
sudo dphys-swapfile swapoff
sudo sed -i 's/^CONF_SWAPSIZE=.*/CONF_SWAPSIZE=2048/' /etc/dphys-swapfile
sudo dphys-swapfile setup
sudo dphys-swapfile swapon
free -h            # confirm ~2 GB of swap
```

---

## 🐳 Part B — Docker

Skip this whole part if `docker compose version` already works — the Pi almost certainly has it for your other apps.

```bash
sudo apt update && sudo apt upgrade -y

# Only if Docker is missing:
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
rm get-docker.sh
sudo usermod -aG docker $USER      # log out and back in afterwards

# Verify
docker --version
docker compose version
docker run --rm hello-world
```

> ⚠️ Warning: `usermod` only takes effect at your **next login**. Log out and back in (or `newgrp docker`) or every `docker` command will say "permission denied".

Also confirm Docker starts at boot — this is what brings Lens back after a power cut:

```bash
systemctl is-enabled docker     # expect: enabled
```

---

## 📦 Part C — Get the Code onto the Pi

The deployable unit is the `monocle-lens/lens` directory inside the repo. Choose one option.

### Option A — rsync from your laptop (recommended)

No Git credentials ever land on the Pi.

**Run this on your laptop**, not the Pi:

```bash
# Create the destination first
ssh reunionparadise@<pi-ip> 'mkdir -p ~/sites/monocle-interview-prep'

# Push the repo, skipping anything that must not travel
rsync -avz --delete \
  --exclude '.git/' \
  --exclude 'node_modules/' \
  --exclude 'dist/' \
  --exclude '__pycache__/' \
  --exclude 'corpus/raw/' \
  --exclude '.env' \
  --exclude 'lens_kv_init.sh' \
  ~/Desktop/Github/monocle-interview-prep/ \
  reunionparadise@<pi-ip>:~/sites/monocle-interview-prep/
```

> ⚠️ Warning: `.env` and `lens_kv_init.sh` are excluded on purpose — you create them **on the Pi**, with the Pi's own ports and the vault credentials. Never rsync a secrets file around.

### Option B — git clone on the Pi

The repository is private, so this needs a read-only **deploy key** or a personal access token:

```bash
mkdir -p ~/sites
git clone https://github.com/tevinric/monocle-interview-prep.git ~/sites/monocle-interview-prep
cd ~/sites/monocle-interview-prep
```

### Confirm the stack directory

Either way, you should now have:

```bash
cd /home/reunionparadise/sites/monocle-interview-prep/monocle-lens/lens
ls -la
# Expect: docker-compose.yml  Makefile  backend/  frontend/  keyvault/  database/
#         corpus/  evals/  docs/  README.md  SETUP.md  .env.example  lens_kv_init.sh.example
```

That long path is the working directory for **every** `docker compose` and `make` command in this guide. Save your fingers:

```bash
echo "alias lensdir='cd /home/reunionparadise/sites/monocle-interview-prep/monocle-lens/lens'" >> ~/.bashrc
source ~/.bashrc
```

---

## 🔌 Part D — Claim Your Ports (Loopback Only)

This is the step that both avoids port clashes **and** keeps Lens off the local network entirely.

```bash
cd /home/reunionparadise/sites/monocle-interview-prep/monocle-lens/lens
cp .env.example .env
nano .env
```

Set the three port lines to bind **only to loopback** by including the IP in the value:

```bash
# ─── Host ports — loopback only: reachable by the tunnel, by nothing else ────
LENS_FRONTEND_PORT=127.0.0.1:3100
LENS_BACKEND_PORT=127.0.0.1:5100
LENS_DB_PORT_HOST=127.0.0.1:5439
```

Save with `Ctrl+X`, `Y`, `Enter`.

### Why this exact form

`docker-compose.yml` publishes ports as `"${LENS_FRONTEND_PORT:-3100}:80"`. Supplying `127.0.0.1:3100` makes that resolve to `"127.0.0.1:3100:80"` — the standard Docker "publish on one interface" syntax. **No application file is edited**, and you get:

| Without the IP (`3100`) | With the IP (`127.0.0.1:3100`) |
|---|---|
| Listens on `0.0.0.0:3100` | Listens on `127.0.0.1:3100` |
| Anyone on your LAN can open the app | Only processes on the Pi can — including `cloudflared` |
| The database port is reachable from the LAN | The database is invisible off-box |
| Relies on a firewall you may not have | Needs no firewall at all |

> 💡 Tip: `cloudflared` runs *on the Pi*, so `http://127.0.0.1:3100` is exactly what it needs and nothing is lost. If you want to browse the app from your laptop during setup before the tunnel exists, use an SSH tunnel rather than opening the port:
> ```bash
> # On your laptop:
> ssh -L 3100:127.0.0.1:3100 reunionparadise@<pi-ip>
> # then open http://localhost:3100 in your laptop's browser
> ```

If Part A found any of those ports in use, choose free ones instead — for example `127.0.0.1:3110`, `127.0.0.1:5110`, `127.0.0.1:5449` — and remember the **frontend** number: it is the one the tunnel points at in [[04 - Isolated Cloudflare Tunnel]].

> ⚠️ Warning: `.env` is git-ignored. It holds no secrets — only ports and optional model settings — but keep it that way: credentials belong in Key Vault ([[02 - Secrets, Entra and the Domain]]).

---

## ✅ Checklist

- [ ] Survey output saved: listening ports, nginx state, existing tunnels, Docker names
- [ ] Ports `3100`, `5100`, `5439` (or your chosen alternatives) confirmed free
- [ ] Port `20253` confirmed free for the tunnel's metrics endpoint
- [ ] Host Nginx identified — and understood to be **out of scope**
- [ ] Existing `cloudflared` service name and config path written down, untouched
- [ ] All `lens_*` Docker names free (or known to be yours from a previous deploy)
- [ ] `aarch64`, ≥ 6 GB disk, ≥ 4 GB RAM (or swap raised)
- [ ] Docker + Compose working without `sudo`, and `docker` enabled at boot
- [ ] Code present at `/home/reunionparadise/sites/monocle-interview-prep/monocle-lens/lens`
- [ ] `.env` created with **loopback-bound** ports

---

> **Next Step:** [[02 - Secrets, Entra and the Domain]] — the vault credentials, and the one Entra change without which sign-in on the new domain cannot work.
