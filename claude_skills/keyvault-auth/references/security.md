# Security posture — what this design does and does not protect

Be accurate about this when reporting to the user. The pattern is good practice; it is
**not** a defence against host compromise, and no host-side secret delivery mechanism is.

## What the secrets volume actually is

`<slug>_secrets` is an ordinary Docker named volume — a directory on the host under
`/var/lib/docker/volumes/<slug>_secrets/_data` holding **plaintext files**. There is no
encryption at rest. Docker's `docker secret` (tmpfs-backed) is a Swarm feature; Compose
has no equivalent.

## Who can read the secrets

| Attacker position | Gets the secrets? | Notes |
|---|---|---|
| Unprivileged host user | No | `/var/lib/docker` is `drwx--x---` root:root |
| **Root, or any member of the `docker` group** | **Yes** | docker-group membership *is* root |
| RCE inside the backend container | Yes | but it already had them in `os.environ` |
| RCE inside the postgres container | Yes | `/secrets` is mounted there too |
| Another app's container on the same host | No | unless someone mounts this volume into it |
| Stolen git repo or image | No | |
| Backup archives | No — **verify this per app** | check the backup compose's volume list |
| Physical theft of the machine | **Yes, if the disk is unencrypted** | |

## What this design genuinely improves

- **`docker inspect` is clean** on the long-lived services. Previously every secret sat
  in the container config, readable by anything reaching the Docker API.
- **App RCE cannot pivot to the vault.** Vault credentials exist only in `keyvault-init`,
  which has exited, and the backend has no Docker socket. This is why the backend must
  never fetch secrets itself — that "simplification" hands vault credentials to the
  internet-facing process.
- **Nothing secret in git, images, or the working tree.**
- **Rotation and audit** — Key Vault logs every read and rotation needs no host edits.

## What gets worse

The service principal's client secret on the host is a **durable, portable credential**.
Root on the box gets it from the init script, the shell history, or
`docker inspect <slug>_keyvault_init`, and can then reach the vault from anywhere until
it is rotated. Whether that reaches *other* apps depends entirely on the grant scope —
see the per-secret scoping section in [vault-setup.md](vault-setup.md).

**On a shared host this compounds:** one root compromise reaches every app's secrets
volume and every app's client secret at once. Per-app vaults and per-app principals limit
what the *stolen credential* can do afterwards; they do not limit what the attacker
already took.

## The ladder — best practice by what credential sits on the box

| | Credential on host | Exfiltratable? |
|---|---|---|
| **Managed identity** (Azure VM / Container Apps / AKS) | none — token from IMDS | No |
| **Azure Arc-enabled server** (on-prem managed identity) | none — token from local Arc agent | No |
| **Certificate auth, TPM-resident key** | public cert only | No — usable on-box, not portable |
| **Certificate auth, PEM on disk** | private key file | Yes |
| **Client secret** ← the default here | the secret string | Yes |

On non-Azure hardware you cannot eliminate "secret zero" without a hardware root of
trust. That is a property of the environment, not a flaw in this design.

### Recommendations, highest value first

1. **One vault per app** (or per-secret RBAC on a shared vault). Cheapest fix, biggest
   blast-radius reduction — especially with several apps co-tenant on one host.
2. **Encrypt the host disk.** If the machine is a laptop or otherwise physically
   reachable, this outranks everything else on the list. Plaintext-on-disk is only an
   acceptable trade when the disk is encrypted.
3. **Short-lived client secrets with a calendared rotation.** Rotation is now one `az`
   command plus a restart — that is the benefit this design bought.
4. **Turn on vault diagnostics and alerting.** Audit is the main advantage over shell
   exports and is worthless switched off.
5. **Azure Arc** if you want to remove secret zero properly. `azcmagent connect` gives an
   on-prem machine a real system-assigned managed identity; `azure-identity` supports it
   via `ManagedIdentityCredential`, and no client secret exists anywhere on the host.
   The wrinkle is containers: the Arc token endpoint is on `127.0.0.1:40342` and is gated
   by a challenge file under `/var/opt/azcmagent/tokens/` readable only by the `himds`
   group, so the init container needs host networking (or `host-gateway`), the token
   directory mounted, and the right GID. Fiddly — but only for **one** container, because
   `keyvault-init` is the only thing holding an identity. This architecture is what makes
   that upgrade a one-service change.

Do not describe an app using this skill as "secure against a compromised server". It is
not, and neither is any alternative that runs the app on that server.
