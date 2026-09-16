#!/usr/bin/env python3
"""
@@SLUG@@ — Azure Key Vault secret bootstrapper.

Runs as a short-lived init container before postgres and the backend start.

It authenticates to Azure Key Vault using the service principal supplied via four
environment variables (the ONLY four that have to exist on the docker host), reads this
application's @@VAULT_PREFIX@@-* secrets, and writes them onto the shared
@@SLUG@@_secrets volume in two forms:

  /secrets/backend.env         a sourceable shell file consumed by the backend
                               container's entrypoint
  /secrets/parts/<SECRET-NAME> one file per secret, consumed by the postgres image's
                               POSTGRES_*_FILE support

Secrets are fetched BY EXACT NAME and the vault is never listed. That is deliberate: it
lets the service principal be granted access to individual secrets rather than the whole
vault, which is what makes a vault shared with other applications safe. Do not add a
list_properties_of_secrets() call.

Exit codes:
  0  all required secrets were fetched and written
  1  authentication / vault access failure, or a required secret is missing
"""

import os
import shlex
import sys

from azure.core.exceptions import ResourceNotFoundError
from azure.identity import ClientSecretCredential
from azure.keyvault.secrets import SecretClient

SECRETS_DIR = os.getenv("@@VAULT_PREFIX@@_SECRETS_DIR", "/secrets")
PARTS_DIR = os.path.join(SECRETS_DIR, "parts")
ENV_FILE = os.path.join(SECRETS_DIR, "backend.env")

# Every @@VAULT_PREFIX@@-* secret this application reads.
#
#   (key vault secret name, container env var name, default)
#
# A default of None marks the secret as REQUIRED — the container exits non-zero and the
# whole stack refuses to start if it is absent. Anything with a default is optional: put
# it in the vault only to override the default.
#
# RULES:
#   * Key Vault secret names may contain only letters, digits and hyphens.
#   * Every name here MUST start with @@VAULT_PREFIX@@- so it cannot collide with another
#     application's secrets in a shared vault.
#   * NEVER give a credential a default. If it is a credential, its default is None.
SECRET_MAP = [
    # ── Database ────────────────────────────────────────────────────────────
    ("@@VAULT_PREFIX@@-DB-NAME",     "@@ENV_PREFIX@@_DB_NAME",     None),
    ("@@VAULT_PREFIX@@-DB-USER",     "@@ENV_PREFIX@@_DB_USER",     None),
    ("@@VAULT_PREFIX@@-DB-PASSWORD", "@@ENV_PREFIX@@_DB_PASSWORD", None),
    # ── Flask ───────────────────────────────────────────────────────────────
    ("@@VAULT_PREFIX@@-SECRET-KEY",  "@@ENV_PREFIX@@_SECRET_KEY",  None),
    ("@@VAULT_PREFIX@@-FLASK-ENV",   "@@ENV_PREFIX@@_FLASK_ENV",   "production"),
    # ── Add this app's own secrets below ────────────────────────────────────
    # ("@@VAULT_PREFIX@@-AZURE-TENANT-ID", "@@ENV_PREFIX@@_AZURE_TENANT_ID", None),
    # ("@@VAULT_PREFIX@@-SMTP-PASSWORD",   "@@ENV_PREFIX@@_SMTP_PASSWORD",   None),
]

# The service principal credentials, supplied by the docker host. These are the only
# values NOT stored in the vault (they are what unlocks it). They carry the app's vault
# prefix so that sourcing several apps' init scripts into one shell cannot cross-wire
# them — a real hazard on a shared host.
BOOTSTRAP_VARS = (
    "@@VAULT_PREFIX@@_AZURE_KEYVAULT_URL",
    "@@VAULT_PREFIX@@_AZURE_TENANT_ID",
    "@@VAULT_PREFIX@@_AZURE_CLIENT_ID",
    "@@VAULT_PREFIX@@_AZURE_CLIENT_SECRET",
)


def fail(message):
    print(f"[keyvault-init] ERROR: {message}", file=sys.stderr)
    sys.exit(1)


def read_bootstrap_config():
    """Read and validate the four service-principal variables from the host."""
    missing = [name for name in BOOTSTRAP_VARS if not os.getenv(name, "").strip()]
    if missing:
        fail(
            "the following variables must be exported in the shell running "
            "docker compose:\n    " + "\n    ".join(missing)
        )
    return {name: os.environ[name].strip() for name in BOOTSTRAP_VARS}


def build_client(config):
    credential = ClientSecretCredential(
        tenant_id=config["@@VAULT_PREFIX@@_AZURE_TENANT_ID"],
        client_id=config["@@VAULT_PREFIX@@_AZURE_CLIENT_ID"],
        client_secret=config["@@VAULT_PREFIX@@_AZURE_CLIENT_SECRET"],
    )
    return SecretClient(
        vault_url=config["@@VAULT_PREFIX@@_AZURE_KEYVAULT_URL"], credential=credential
    )


def fetch_all(client):
    """Pull every mapped secret by exact name. Returns (values, missing_required)."""
    values = {}
    parts = {}
    missing_required = []

    for secret_name, env_var, default in SECRET_MAP:
        try:
            value = client.get_secret(secret_name).value
        except ResourceNotFoundError:
            value = None
        except Exception as exc:  # auth failure, network, RBAC denial, ...
            fail(
                f"could not read '{secret_name}' from the vault: {exc}\n"
                "Check that the service principal has the 'Key Vault Secrets User' role "
                "(or a get secrets access policy) covering this secret."
            )

        if value is None or value == "":
            if default is None:
                missing_required.append(secret_name)
                continue
            print(f"[keyvault-init] {secret_name}: not set, using default")
            value = default
        else:
            print(f"[keyvault-init] {secret_name}: loaded")

        values[env_var] = value
        parts[secret_name] = value

    return (values, parts), missing_required


def write_outputs(values, parts):
    """Write the sourceable env file and the per-secret files."""
    os.makedirs(PARTS_DIR, exist_ok=True)

    lines = [
        "# Generated by keyvault-init from Azure Key Vault. Do not edit.",
        "# Sourced by the backend container entrypoint at startup.",
    ]
    for _, env_var, _ in SECRET_MAP:
        if env_var in values:
            # shlex.quote keeps passwords containing quotes, $, backticks or
            # semicolons intact and inert when the file is sourced.
            lines.append(f"export {env_var}={shlex.quote(values[env_var])}")

    with open(ENV_FILE, "w", encoding="utf-8") as handle:
        handle.write("\n".join(lines) + "\n")
    os.chmod(ENV_FILE, 0o644)

    # The postgres image reads POSTGRES_DB_FILE / _USER_FILE / _PASSWORD_FILE after
    # dropping to the unprivileged `postgres` user, so these must stay world-readable
    # inside the container. The volume is private to this app's compose stack.
    for secret_name, value in parts.items():
        path = os.path.join(PARTS_DIR, secret_name)
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(value)
        os.chmod(path, 0o644)

    return len(parts)


def main():
    config = read_bootstrap_config()
    print(f"[keyvault-init] vault: {config['@@VAULT_PREFIX@@_AZURE_KEYVAULT_URL']}")

    client = build_client(config)
    (values, parts), missing_required = fetch_all(client)

    if missing_required:
        fail(
            "the following REQUIRED secrets are missing from the vault:\n    "
            + "\n    ".join(missing_required)
            + "\nSee README.md for the full list of @@VAULT_PREFIX@@-* secrets."
        )

    count = write_outputs(values, parts)
    print(f"[keyvault-init] wrote {count} secrets to {SECRETS_DIR}")
    print("[keyvault-init] done")


if __name__ == "__main__":
    main()
