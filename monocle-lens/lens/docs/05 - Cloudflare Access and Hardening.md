# 05 — Cloudflare Access and Hardening

> **Navigation:** [[00 - Monocle Lens Pi Deployment Home]] | Prev: [[04 - Isolated Cloudflare Tunnel]] | Next: [[06 - Operations, Updates and Reboots]]

---

## 🎯 Goal of This Step

An identity wall at Cloudflare's edge, in front of `monocle-interview-prep-tevin-richard.unismartsolutions.co.za`, plus the zone-level TLS settings. By the end, a stranger who finds the URL is stopped **before a packet reaches your Pi**.

---

## 🤔 First: Do You Want Access In Front of This One?

Lens is not an unprotected app. It already enforces Entra ID sign-in on every API call, with *Assignment required* on the enterprise application ([[02 - Secrets, Entra and the Domain]]). Cloudflare Access is a **second, outer** wall. Whether you want it depends on what this deployment is for.

| Option | What a visitor experiences | Choose it when |
|---|---|---|
| **A. Access with One-time PIN** | Cloudflare email-code screen → then the Lens Entra sign-in | The URL should be invisible to everyone but a named list. Most secure. |
| **B. Access with Entra as the identity provider** | One Microsoft sign-in that satisfies both walls | You want maximum security with minimum friction. Best steady state. |
| **C. No Access; rely on Entra only** | Lens sign-in page, then Microsoft | You are demonstrating live and want zero surprises, or an interviewer needs to reach the page without you provisioning them. |

> ⚠️ Warning — **demo-day trap:** if you protect the domain with Access and your policy allows only `tevinric@gmail.com`, an interviewer opening the link gets a Cloudflare login screen and **cannot** get in — not even to see the Lens sign-in page. Decide in advance:
> - you drive the demo yourself (Access on is fine), **or**
> - add their email to the Allow policy beforehand, **or**
> - choose Option C for the duration and re-enable Access afterwards.
>
> Whichever you choose, the app itself is never unauthenticated: `LENS-ENV-TYPE=PROD` means the API refuses every call without a valid Entra token.

Option **B** is written out below; **A** is the same with a different identity provider, and **C** is simply "skip Part A and B".

---

## 🔐 Part A — Create the Access Application

### Step 1 — Open Zero Trust

Go to [one.dash.cloudflare.com](https://one.dash.cloudflare.com/).

If you set up a team for an earlier app, **reuse it** — you are adding an application, not a team. If this is the first time, choose a team name (e.g. `tevs-team`), which becomes your `https://tevs-team.cloudflareaccess.com` login domain. The Free plan covers 50 users.

### Step 2 — Choose the login method

**Settings → Authentication → Login methods.**

- **One-time PIN** works with zero setup — a 6-digit code by email.
- For Option B, **Add new → Microsoft Entra ID** and supply a client ID, client secret and directory ID from a *separate* app registration created for Cloudflare Access.

> ⚠️ Warning: Do **not** reuse the Lens SPA registration as the Access identity provider. Access is a confidential client and needs its own registration with a client **secret**; the Lens SPA registration deliberately has none. Create a second registration (Web platform, redirect URI `https://<team-name>.cloudflareaccess.com/cdn-cgi/access/callback`) for this purpose.

### Step 3 — Add the application

**Access → Applications → Add an application → Self-hosted.**

| Field | Value |
|---|---|
| Application name | `Monocle Lens` |
| Session duration | `24 hours` |
| Subdomain | `monocle-interview-prep-tevin-richard` |
| Domain | `unismartsolutions.co.za` |
| Path | *(leave empty — protects the whole host)* |

Under **Identity providers**, select the one from Step 2.

### Step 4 — Add the policy

| Field | Value |
|---|---|
| Policy name | `Allow Tevin` |
| Action | **Allow** |
| Include | Selector **Emails** → `tevinric@gmail.com` |

Add further `Allow` emails for anyone else who should reach the app — an interviewer, a reviewer. Anyone not matched is **denied by default**.

Save the application.

### Step 5 — Test it

```bash
curl -I https://monocle-interview-prep-tevin-richard.unismartsolutions.co.za
```

Expected now: a **`302`** to `<team>.cloudflareaccess.com`, not a `200`. That redirect is the wall doing its job.

Then open the URL in a **private/incognito window**:

1. Cloudflare Access login → email + one-time code (or Microsoft sign-in).
2. Then the Lens interface → **Sign in with Microsoft**.
3. Then the app, greeting you by first name and offering the guided tour.

---

## 🔏 Part B — Zone TLS Settings

In the Cloudflare dashboard for `unismartsolutions.co.za`:

- **SSL/TLS → Overview** → **Full (strict)**
- **SSL/TLS → Edge Certificates** → **Always Use HTTPS**: on
- **SSL/TLS → Edge Certificates** → **Minimum TLS Version**: 1.2

> ⚠️ Warning: These are **zone-wide** settings shared with your other applications. If another app on this zone is already working, these are almost certainly set — check, and only change them if you are sure. Changing the SSL mode affects every hostname in the zone, which is precisely the kind of collateral this deployment otherwise avoids.

There is no certificate to install or renew on the Pi. The browser↔Cloudflare leg is HTTPS; the Cloudflare↔Pi leg *is* the tunnel, which `cloudflared` encrypts.

---

## 🧱 Part C — What the Pi Exposes Now

Re-run the proof from [[03 - Deploy the Stack on the Pi]] and confirm nothing changed when the tunnel went live:

```bash
# Lens's three ports: loopback only
sudo ss -ltnp | grep -E '3100|5100|5439'

# No new externally-bound listener appeared
sudo ss -ltnp | grep -v '127.0.0.1' | grep LISTEN
```

| Asset | Reachable from the internet? | How it is protected |
|---|---|---|
| Frontend `3100` | Only **through** the tunnel | Loopback bind + Access + Entra |
| Backend `5100` | **No** | Loopback bind; the tunnel has no ingress rule for it |
| PostgreSQL `5439` | **No** | Loopback bind; the tunnel has no ingress rule for it |
| Tunnel metrics `20253` | **No** | Loopback bind |
| SSH `22` | Only if you already forward it | Unchanged by this deployment |

> 💡 Tip: The `http_status:404` catch-all in `/etc/cloudflared/monocle-lens.yml` is what makes the middle two rows true. Even if someone knew the Pi had an API on `5100`, this tunnel has no rule that could route to it.

---

## 🧰 Optional — SSH Through the Same Tunnel

If you want Access-gated SSH to the Pi without opening a port, add a rule **above** the catch-all in `/etc/cloudflared/monocle-lens.yml`:

```yaml
  - hostname: ssh.monocle-interview-prep-tevin-richard.unismartsolutions.co.za
    service: ssh://127.0.0.1:22
```

```bash
cloudflared tunnel route dns monocle-lens ssh.monocle-interview-prep-tevin-richard.unismartsolutions.co.za
sudo systemctl restart cloudflared-monocle-lens
```

On your laptop, in `~/.ssh/config`:

```
Host lens-pi
    HostName ssh.monocle-interview-prep-tevin-richard.unismartsolutions.co.za
    User reunionparadise
    ProxyCommand cloudflared access ssh --hostname %h
```

> ⚠️ Warning: Give that hostname its **own** Cloudflare Access application and Allow policy, or you have published an SSH endpoint. And note this restarts **our** tunnel service only — the other apps' tunnels are untouched.

> 💡 Tip: If another app already provides Access-gated SSH to this Pi, skip this entirely. One SSH path is enough, and a second is a second thing to secure.

---

## ✅ Checklist

- [ ] Demo-day access decision made and written down (A, B or C)
- [ ] *(A/B)* Access application created for the exact hostname
- [ ] *(A/B)* Allow policy lists every email that must get in
- [ ] *(B)* A **separate** Entra registration created for Access — not the Lens SPA one
- [ ] `curl -I` returns `302` to the Access login (or `200` if you chose C)
- [ ] Incognito test: Access → Lens sign-in → app
- [ ] Zone TLS reviewed (and not changed unless you were sure)
- [ ] `ss -ltnp` still shows Lens on loopback only
- [ ] Backend and database confirmed unreachable from the internet

---

> **Next Step:** [[06 - Operations, Updates and Reboots]] — the commands you will actually use from here on.
