# 🏠 Monocle Lens — Raspberry Pi Deployment Home

> The complete, step-by-step guide to deploying **Monocle Lens** (PostgreSQL + pgvector · Flask/Gunicorn · React + Nginx · Azure Key Vault init) onto the shared Raspberry Pi, served securely at `https://monocle-interview-prep-tevin-richard.unismartsolutions.co.za` through its **own isolated Cloudflare Tunnel**.

---

## 📖 What This Guide Covers

Lens is a four-service containerised app: a short-lived **Key Vault bootstrapper**, **PostgreSQL 16 + pgvector**, a **Flask/Gunicorn** API, and a **React + Nginx** frontend — all in one `docker-compose.yml`. This vault takes you from the code on your laptop to a live, internet-reachable deployment with **no open ports**, an identity wall at the Cloudflare edge, and Entra ID sign-in inside the app.

The Pi already runs other applications, each with its own tunnel, and may run a host-level Nginx. **Nothing in this guide touches any of them.** Every step is additive and reversible, and [[04 - Isolated Cloudflare Tunnel]] is written specifically around that constraint.

---

## 🗺️ Guide Map

| Step | Page | What You'll Do |
|------|------|----------------|
| 1 | [[01 - Pi Survey and Prerequisites]] | Audit what the Pi already runs, claim free ports, get the code on board |
| 2 | [[02 - Secrets, Entra and the Domain]] | Key Vault secrets, the new redirect URI, `PROD` sign-in |
| 3 | [[03 - Deploy the Stack on the Pi]] | Build, start, ingest the corpus, verify locally on loopback |
| 4 | [[04 - Isolated Cloudflare Tunnel]] | A second tunnel that cannot disturb the first — own config, own service, own metrics port |
| 5 | [[05 - Cloudflare Access and Hardening]] | The identity wall, TLS settings, demo-day access decisions |
| 6 | [[06 - Operations, Updates and Reboots]] | Day-two commands, redeploys, reboot behaviour, clean removal |
| 7 | [[07 - Troubleshooting]] | Every failure mode across all stages, with the command that diagnoses it |

Related, already in this folder: **[ENTRA_SETUP.md](ENTRA_SETUP.md)** — the full app-registration walkthrough. This guide assumes that registration exists and only adds the new production URL to it.

---

## ⚡ Quick Reference

| Thing | Value |
|-------|-------|
| Repo directory (on Pi) | `/home/reunionparadise/sites/monocle-interview-prep` |
| **Stack directory** (where `docker compose` runs) | `/home/reunionparadise/sites/monocle-interview-prep/monocle-lens/lens` |
| Public URL | `https://monocle-interview-prep-tevin-richard.unismartsolutions.co.za` |
| Frontend port (host, loopback only) | `127.0.0.1:3100` |
| Backend port (host, loopback only) | `127.0.0.1:5100` |
| Database port (host, loopback only) | `127.0.0.1:5439` |
| Docker network | `lens_net` |
| Docker volumes | `lens_pg_data`, `lens_secrets` |
| Containers | `lens_keyvault_init`, `lens_db`, `lens_backend`, `lens_frontend` |
| **Cloudflare tunnel name** | `monocle-lens` |
| **Tunnel config** | `/etc/cloudflared/monocle-lens.yml` |
| **Tunnel service** | `cloudflared-monocle-lens.service` |
| **Tunnel metrics** | `127.0.0.1:20253` |
| Backend health check | `curl http://127.0.0.1:5100/api/health` |
| Secrets source | Azure Key Vault, fetched at startup by `lens_keyvault_init` |

**The one command that starts everything** (after first-time setup):
```bash
cd /home/reunionparadise/sites/monocle-interview-prep/monocle-lens/lens \
  && source ./lens_kv_init.sh && make up
```

**Stop everything (data kept):**
```bash
cd /home/reunionparadise/sites/monocle-interview-prep/monocle-lens/lens && make down
```

> 💡 Tip: `reunionparadise` is the Pi user used throughout, to match the Zoe Library vault. If yours differs, substitute it everywhere — or run `echo $HOME` on the Pi and use that.

---

## 🧠 How the Traffic Flows

```
Browser, anywhere in the world
      │
      ▼
https://monocle-interview-prep-tevin-richard.unismartsolutions.co.za
      │
      ▼
Cloudflare edge
   ├─ Cloudflare Access   → identity wall (layer 1: who may even see the app)
   └─ HTTPS termination + DDoS protection
      │
      ▼
Cloudflare Tunnel "monocle-lens"  ── encrypted, OUTBOUND from the Pi.
                                     No inbound ports. No port forwarding.
      │
      ▼
cloudflared-monocle-lens.service   (its own systemd unit on the Pi)
      │
      └─ ONLY  →  http://127.0.0.1:3100   (lens_frontend, Nginx in a container)
                        │
                        └─ /api  →  lens_backend:5000  (inside lens_net)
                                          │
                                          └─ lens_db:5432  (inside lens_net)
```

Two walls, not one:

| Layer | Enforced by | What it answers |
|---|---|---|
| **1. Cloudflare Access** | Cloudflare edge, before a packet reaches the Pi | *May you see this application at all?* |
| **2. Entra ID sign-in** | `backend/lens/auth.py`, on every single API call | *Are you an assigned user of the Lens app registration?* |

The database and the API are never published beyond loopback, and the tunnel's ingress rules can reach exactly one address. See [[04 - Isolated Cloudflare Tunnel]].

---

## 🛡️ The Isolation Promise

This deployment shares a Pi with other applications. Here is precisely how each collision is avoided — the detail is in the page named in the last column.

| Shared resource | How Lens stays out of the way | Page |
|---|---|---|
| **Host Nginx (`:80`/`:443`)** | Never touched. Lens's Nginx runs *inside* its container and is published on `127.0.0.1:3100` only. No server block is added, no config reloaded. | [[01 - Pi Survey and Prerequisites]] |
| **The other apps' Cloudflare tunnels** | A **separate tunnel**, **separate config file**, **separate credentials**, **separate systemd unit**, **separate metrics port**. `cloudflared service install` is never run. | [[04 - Isolated Cloudflare Tunnel]] |
| **Docker names** | Every container, volume and network already carries the `lens_` prefix. Verified free before first start. | [[01 - Pi Survey and Prerequisites]] |
| **Host ports** | `3100` / `5100` / `5439`, bound to loopback, checked for clashes first. Overridable in `.env` without editing any app file. | [[01 - Pi Survey and Prerequisites]] |
| **DNS / the zone** | One new proxied CNAME for one subdomain. No existing record is altered. | [[04 - Isolated Cloudflare Tunnel]] |
| **Azure Key Vault** | Lens's own service principal, its own `LENS-*` secrets. | [[02 - Secrets, Entra and the Domain]] |

> ⚠️ Warning: The single most dangerous command in this whole deployment is `sudo cloudflared service install`. It overwrites the shared `/etc/systemd/system/cloudflared.service` and would repoint or restart whatever tunnel your other apps use. **It appears nowhere in this guide, and you must not run it.** [[04 - Isolated Cloudflare Tunnel]] builds a dedicated unit instead.

---

## 📁 What Gets Created on the Pi

```
/home/reunionparadise/sites/monocle-interview-prep/     ← the repo
└── monocle-lens/lens/                                  ← the stack directory
    ├── docker-compose.yml                              (unchanged, from the repo)
    ├── .env                                            ← YOU create — ports only, no secrets
    ├── lens_kv_init.sh                                 ← YOU create — 4 vault variables, chmod 600
    ├── corpus/raw/                                     (filled by `make ingest`)
    └── docs/                                           ← this guide

/etc/cloudflared/
    ├── config.yml                                      ⚠️ EXISTING — belongs to another app, do not edit
    ├── <other-app-uuid>.json                           ⚠️ EXISTING — do not touch
    ├── monocle-lens.yml                                ← NEW, ours
    └── <monocle-lens-uuid>.json                        ← NEW, ours

/etc/systemd/system/
    ├── cloudflared.service                             ⚠️ EXISTING — do not edit
    └── cloudflared-monocle-lens.service                ← NEW, ours
```

---

## 🔗 Useful External Links

- Cloudflare Tunnel — https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/
- Running multiple tunnels / config files — https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/configure-tunnels/local-management/configuration-file/
- Cloudflare Zero Trust / Access — https://developers.cloudflare.com/cloudflare-one/policies/access/
- Microsoft Entra ID app registrations — https://learn.microsoft.com/entra/identity-platform/quickstart-register-app
- Docker Compose — https://docs.docker.com/compose/
- pgvector — https://github.com/pgvector/pgvector

---

## 🧭 How to Read This Vault

- **First-time deployment?** Go in order, 01 → 05. Do not skip [[01 - Pi Survey and Prerequisites]] — it is the page that keeps the other apps safe.
- **App already running, just need it online?** [[04 - Isolated Cloudflare Tunnel]] then [[05 - Cloudflare Access and Hardening]].
- **Something broke?** [[07 - Troubleshooting]] is organised by stage.

---
*Deployment target: `monocle-interview-prep-tevin-richard.unismartsolutions.co.za` · Last updated: September 2026*
