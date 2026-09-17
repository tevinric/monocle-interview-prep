# 03 — Deploy the Stack on the Pi

> **Navigation:** [[00 - Monocle Lens Pi Deployment Home]] | Prev: [[02 - Secrets, Entra and the Domain]] | Next: [[04 - Isolated Cloudflare Tunnel]]

---

## 🎯 Goal of This Step

By the end of this page all four Lens containers are running on the Pi, the corpus is ingested, and you have proved the whole application works over `127.0.0.1` — **before** any of it is exposed to the internet.

> 💡 Tip: This local-first order is deliberate. If it works here and fails through the domain later, the fault is in the tunnel layer ([[04 - Isolated Cloudflare Tunnel]]), not the app. That one fact saves hours.

---

## ✅ Pre-flight

```bash
cd /home/reunionparadise/sites/monocle-interview-prep/monocle-lens/lens

# From page 01
cat .env | grep LENS_.*PORT          # expect the 127.0.0.1: prefixed values

# From page 02
source ./lens_kv_init.sh
echo "$LENS_AZURE_KEYVAULT_URL"      # must not be empty

# Docker is healthy
docker compose version
```

---

## 🏗️ Part A — Build and Start

The first build compiles three images on the Pi: the Key Vault bootstrapper, the Flask backend, and the React frontend (Node build + Nginx). **Expect 10–25 minutes on a Pi 4/5.** Later builds are minutes.

```bash
cd /home/reunionparadise/sites/monocle-interview-prep/monocle-lens/lens
source ./lens_kv_init.sh
make up
```

`make up` is a thin wrapper for `docker compose up --build -d`, with a guard that refuses to run if the four vault variables are missing.

Watch it work in a second SSH session if you like:

```bash
cd /home/reunionparadise/sites/monocle-interview-prep/monocle-lens/lens
docker compose logs -f
```

> 💡 Tip: Everything in the stack has an `arm64` image (`python:3.11-slim`, `node:20-alpine`, `nginx:alpine`, `pgvector/pgvector:pg16`) and every Python dependency ships an `aarch64` wheel, so no cross-compilation or emulation is involved. If the Node build is killed part-way with no error, that is the memory ceiling — raise swap (see [[01 - Pi Survey and Prerequisites]], Part A Step 5) and re-run.

### Confirm the startup sequence

```bash
docker compose ps
```

Expected — note that **`lens_keyvault_init` having exited is correct**, it is a run-once init container:

| Container | Expected state |
|---|---|
| `lens_keyvault_init` | `Exited (0)` |
| `lens_db` | `Up … (healthy)` |
| `lens_backend` | `Up … (healthy)` |
| `lens_frontend` | `Up … (healthy)` |

If `lens_keyvault_init` exited non-zero, nothing else will have started. Read why:

```bash
docker logs lens_keyvault_init
```

That log names the missing secret or the vault permission problem explicitly.

---

## 🔍 Part B — Verify on Loopback

### 1. The API is healthy and sign-in is enforced

```bash
curl -s http://127.0.0.1:5100/api/health
```

Expected:

```json
{"status":"healthy","database":"connected","auth":"entra","env_type":"PROD"}
```

> ⚠️ Warning: If this says `"auth":"bypassed"` or `"env_type":"DEV"`, **stop**. The vault still has `LENS-ENV-TYPE=DEV` and the app would be served to the internet with no sign-in. Fix it in [[02 - Secrets, Entra and the Domain]] Part A, then:
> ```bash
> docker compose up -d --force-recreate keyvault-init backend
> ```

### 2. Sign-in is actually wired up

```bash
curl -s http://127.0.0.1:5100/api/auth/config
```

Expected: JSON containing `"mode":"entra"` with your tenant authority and client id. `"mode":"open"` means the same problem as above.

And a protected route must refuse an anonymous caller:

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:5100/api/runs
```

Expected: **`401`**. Anything else means the API is unprotected — do not continue to the tunnel.

### 3. Prove the Entra validator end to end (optional but recommended)

```bash
make check-auth
```

Fetches your tenant's live signing keys and then requires the validator to reject a set of deliberately wrong tokens. No real token needed, nothing written.

### 4. The frontend serves

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3100/
```

Expected: **`200`**.

### 5. Nothing is exposed beyond loopback

This is the check that proves page 01's port work:

```bash
sudo ss -ltnp | grep -E '3100|5100|5439'
```

Every line must show `127.0.0.1:PORT` — **not** `0.0.0.0:PORT` or `*:PORT`.

```bash
# From your LAPTOP, this must fail/refuse:
curl --max-time 5 http://<pi-ip>:3100/ ; echo "exit=$?"
```

Expected: connection refused or timeout. Good.

---

## 🧠 Part C — Check the Models, Then Build the Corpus

### 1. Prove the models answer before spending anything

```bash
make check-model
```

Calls the chat, judge and embedding models with the exact parameters Lens sends. A wrong model name or an unsupported parameter fails here in seconds instead of halfway through ingest.

### 2. Ingest the six regulatory documents

```bash
make ingest
```

Downloads each source to `corpus/raw/`, records its SHA-256, parses it into sections, chunks, embeds and rebuilds the ivfflat index. **Allow 10–20 minutes on a Pi** (PDF parsing is the slow part; embedding is API-bound). Embedding the whole corpus is roughly **$0.006**.

A source that fails to download is marked `unavailable` rather than silently dropped — the app shows it as such on the Corpus screen.

### 3. Populate the history so the app is not empty

```bash
make seed
```

This inserts prior conversations — including an abstention and a deliberate tool error — so the Audit screen has something in it the moment anyone opens the app. It also gives the guided tour a real trace to walk through.

> 💡 Tip: Without `make seed`, the guided tour quietly skips its six trace stops (there is no run to open) and the Audit screen is empty. For a deployment you plan to demonstrate, seed it.

### 4. Optional — record demo-mode responses

```bash
make record     # needs a live OpenAI key; saves the responses demo mode replays
```

Useful insurance for a demonstration on an unreliable network. Demo mode itself is switched on with `LENS_DEMO_MODE=true` in `.env` plus a recreate of the backend.

---

## 🖥️ Part D — Look At It In a Browser (Before the Domain Exists)

The ports are loopback-only, so use an SSH tunnel from your laptop:

```bash
# On your LAPTOP
ssh -L 3100:127.0.0.1:3100 reunionparadise@<pi-ip>
```

Leave that session open and browse to **http://localhost:3100**.

> ⚠️ Warning: Sign-in will **fail** at this stage, and that is expected and correct. The browser's origin is `http://localhost:3100`, which is a registered redirect URI, but the whole point of the deployment is the real domain. What you are checking here is that the page loads, the styling is right, and the API is reachable — not that you can log in. If `http://localhost:3100` *is* in your redirect URI list (page 02 kept it), sign-in will work here too.

Press `Ctrl+D` to close the SSH tunnel when done.

---

## 📜 Reading Logs

```bash
cd /home/reunionparadise/sites/monocle-interview-prep/monocle-lens/lens

docker compose logs -f                 # everything, live
docker compose logs -f backend         # the API — most useful
docker compose logs -f frontend        # nginx access/error
docker logs lens_keyvault_init         # the one-shot secret fetch
docker compose logs --tail=100 backend # last 100 lines, no follow
```

---

## ✅ Checklist

- [ ] `make up` completed; images built on the Pi
- [ ] `lens_keyvault_init` shows `Exited (0)`; the other three are `Up (healthy)`
- [ ] `/api/health` reports `"auth":"entra"` and `"env_type":"PROD"`
- [ ] `/api/runs` returns **401** without a token
- [ ] `/` on the frontend port returns **200**
- [ ] `ss -ltnp` shows all three ports on `127.0.0.1` only
- [ ] The app is **not** reachable from the LAN
- [ ] `make check-model` passed
- [ ] `make ingest` completed — six documents present
- [ ] `make seed` run, so the Audit screen and the guided tour have content

---

> **Next Step:** [[04 - Isolated Cloudflare Tunnel]] — put it online on its own tunnel, without disturbing a single thing the Pi already runs.
