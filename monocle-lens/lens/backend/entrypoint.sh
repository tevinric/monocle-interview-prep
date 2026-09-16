#!/usr/bin/env bash
# =============================================================================
# lens — backend container entrypoint
# =============================================================================
# The keyvault-init container has already run to completion (compose waits for it
# via `service_completed_successfully`) and written this app's secrets, pulled from
# Azure Key Vault, to /secrets/backend.env. Load them into the environment, then
# hand over to the image's CMD (gunicorn).
#
# Secrets are never baked into the image and never appear in `docker inspect` for
# this service — they exist only in the mounted volume and the process environment.
# =============================================================================
set -euo pipefail

SECRETS_FILE="${LENS_SECRETS_FILE:-/secrets/backend.env}"

if [ ! -f "$SECRETS_FILE" ]; then
    echo "[backend] ERROR: $SECRETS_FILE not found." >&2
    echo "[backend] The keyvault-init container did not produce the secrets file." >&2
    echo "[backend] Run: docker compose logs keyvault-init" >&2
    exit 1
fi

# shellcheck disable=SC1090
. "$SECRETS_FILE"

echo "[backend] loaded secrets from Azure Key Vault via $SECRETS_FILE"

exec "$@"
