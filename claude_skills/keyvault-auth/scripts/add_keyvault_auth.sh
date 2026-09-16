#!/usr/bin/env bash
# =============================================================================
# keyvault-auth — wire an app's secrets to Azure Key Vault
# =============================================================================
#   add_keyvault_auth.sh <app_dir> <VAULT_PREFIX> <ENV_PREFIX> <slug> [--force]
#
# e.g. add_keyvault_auth.sh ~/Desktop/Github/library-app LIBAPP LIBRARYAPP library_app
#
# Writes keyvault/, backend/entrypoint.sh, <slug>_kv_init.sh.example and a compose
# snippet to merge by hand. It does NOT edit docker-compose.yml — every app's
# compose differs and a bad automated merge is worse than a manual one.
#
# These apps share a Docker daemon, and volume / container / network names are
# GLOBAL to it. The script refuses to proceed if any name it would introduce is
# already taken, because a silent volume collision makes one app boot with another
# app's credentials and raises no error.
# =============================================================================
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATES="$SKILL_DIR/templates"

die()  { printf '\n\033[31mERROR:\033[0m %s\n\n' "$1" >&2; exit 1; }
info() { printf '  %s\n' "$1"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }

usage() {
    sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 1
}

[ $# -ge 4 ] || usage

APP_DIR="${1%/}"
VAULT_PREFIX="$2"
ENV_PREFIX="$3"
SLUG="$4"
FORCE="${5:-}"

# ── Validate ────────────────────────────────────────────────────────────────
[ -d "$APP_DIR" ] || die "app directory not found: $APP_DIR"
[ -f "$APP_DIR/docker-compose.yml" ] || die "no docker-compose.yml in $APP_DIR — is this an app root?"
[ -d "$APP_DIR/backend" ] || die "no backend/ directory in $APP_DIR"
[ -d "$TEMPLATES" ] || die "templates not found at $TEMPLATES"

# VAULT_PREFIX prefixes BOTH Key Vault secret names (letters/digits/hyphens only)
# and shell variable names (no hyphens allowed) — so it must be plain uppercase
# alphanumerics, starting with a letter.
[[ "$VAULT_PREFIX" =~ ^[A-Z][A-Z0-9]*$ ]] \
    || die "VAULT_PREFIX must be uppercase letters/digits starting with a letter (got '$VAULT_PREFIX').
       It prefixes both Key Vault secret names and shell variables, so no hyphens or underscores."
[[ "$ENV_PREFIX" =~ ^[A-Z][A-Z0-9_]*$ ]] \
    || die "ENV_PREFIX must be uppercase letters/digits/underscores (got '$ENV_PREFIX')"
[[ "$SLUG" =~ ^[a-z][a-z0-9_-]*$ ]] \
    || die "slug must be lowercase letters/digits/_/- starting with a letter (got '$SLUG')"

APP_DIR="$(cd "$APP_DIR" && pwd)"

VOLUME_NAME="${SLUG}_secrets"
CONTAINER_NAME="${SLUG}_keyvault_init"
INIT_SCRIPT="${SLUG}_kv_init.sh"

printf '\n\033[1mkeyvault-auth\033[0m — %s\n\n' "$APP_DIR"
info "vault prefix : ${VAULT_PREFIX}-*        (secret names)"
info "env prefix   : ${ENV_PREFIX}_*         (container variables)"
info "slug         : ${SLUG}"
printf '\n'

# ── Shared-host collision checks ────────────────────────────────────────────
printf '\033[1mChecking for collisions on the shared Docker host\033[0m\n'
COLLISION=0

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    if docker volume inspect "$VOLUME_NAME" >/dev/null 2>&1; then
        USERS="$(docker ps -a --filter "volume=$VOLUME_NAME" --format '{{.Names}}' | paste -sd, -)"
        if [ -n "$USERS" ]; then
            warn "volume '$VOLUME_NAME' already exists and is used by: $USERS"
        else
            warn "volume '$VOLUME_NAME' already exists (no containers currently attached)"
        fi
        warn "  If that volume belongs to a DIFFERENT app, choose another slug — a shared"
        warn "  secrets volume makes both apps boot with each other's credentials, silently."
        COLLISION=1
    else
        ok "volume '$VOLUME_NAME' is free"
    fi

    if docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER_NAME"; then
        warn "container name '$CONTAINER_NAME' is already taken"
        COLLISION=1
    else
        ok "container name '$CONTAINER_NAME' is free"
    fi

    # Report the neighbours so the operator can eyeball the namespace.
    printf '\n  Existing secrets volumes on this host:\n'
    if docker volume ls --format '{{.Name}}' | grep -E '_secrets$' | sed 's/^/    /'; then :; else
        printf '    (none)\n'
    fi
else
    warn "docker not reachable — skipping collision checks. Verify by hand that"
    warn "  '$VOLUME_NAME' and '$CONTAINER_NAME' are unused on the target host."
fi

# The generated files must not clobber an existing wiring.
if [ -e "$APP_DIR/keyvault" ] || [ -e "$APP_DIR/backend/entrypoint.sh" ]; then
    warn "this app already has keyvault/ or backend/entrypoint.sh"
    COLLISION=1
fi

if [ "$COLLISION" -eq 1 ] && [ "$FORCE" != "--force" ]; then
    die "collisions found (above). Pick a different slug, or re-run with --force if you
       are certain these belong to THIS app and you intend to overwrite them."
fi
printf '\n'

# ── Generate ────────────────────────────────────────────────────────────────
substitute() {
    sed -e "s|@@VAULT_PREFIX@@|$VAULT_PREFIX|g" \
        -e "s|@@ENV_PREFIX@@|$ENV_PREFIX|g" \
        -e "s|@@SLUG@@|$SLUG|g" \
        "$1" > "$2"
}

printf '\033[1mWriting files\033[0m\n'
mkdir -p "$APP_DIR/keyvault"

substitute "$TEMPLATES/fetch_secrets.py"   "$APP_DIR/keyvault/fetch_secrets.py"
substitute "$TEMPLATES/Dockerfile"         "$APP_DIR/keyvault/Dockerfile"
substitute "$TEMPLATES/requirements.txt"   "$APP_DIR/keyvault/requirements.txt"
substitute "$TEMPLATES/compose-snippet.yml" "$APP_DIR/keyvault/compose-snippet.yml"
substitute "$TEMPLATES/entrypoint.sh"      "$APP_DIR/backend/entrypoint.sh"
substitute "$TEMPLATES/kv_init.sh.example" "$APP_DIR/${INIT_SCRIPT}.example"
chmod +x "$APP_DIR/backend/entrypoint.sh" "$APP_DIR/${INIT_SCRIPT}.example"

ok "keyvault/fetch_secrets.py      (edit SECRET_MAP — starter covers DB + SECRET_KEY)"
ok "keyvault/Dockerfile"
ok "keyvault/requirements.txt"
ok "keyvault/compose-snippet.yml   (merge into docker-compose.yml by hand)"
ok "backend/entrypoint.sh"
ok "${INIT_SCRIPT}.example"

# ── gitignore ───────────────────────────────────────────────────────────────
GITIGNORE="$APP_DIR/.gitignore"
touch "$GITIGNORE"
if grep -qx "$INIT_SCRIPT" "$GITIGNORE" 2>/dev/null; then
    ok ".gitignore already covers $INIT_SCRIPT"
else
    printf '%s\n' "$INIT_SCRIPT" >> "$GITIGNORE"
    ok ".gitignore += $INIT_SCRIPT"
fi

# ── Sanity check the generated python ───────────────────────────────────────
if command -v python3 >/dev/null 2>&1; then
    python3 -c "import ast,sys; ast.parse(open(sys.argv[1]).read())" \
        "$APP_DIR/keyvault/fetch_secrets.py" && ok "fetch_secrets.py parses"
fi
bash -n "$APP_DIR/backend/entrypoint.sh" && ok "entrypoint.sh parses"

# ── Next steps ──────────────────────────────────────────────────────────────
cat <<NEXT

$(printf '\033[1mNext steps\033[0m')

  1. Edit keyvault/fetch_secrets.py — add this app's own secrets to SECRET_MAP.
     Credentials get default None (required). Tunables get a real default.

  2. Merge keyvault/compose-snippet.yml into docker-compose.yml:
       • add the keyvault-init service
       • switch postgres to POSTGRES_*_FILE + the file-reading healthcheck
       • add depends_on: keyvault-init / service_completed_successfully to
         postgres AND backend
       • DELETE every secret from the backend environment: block
       • add the ${VOLUME_NAME} volume with an explicit name:

  3. backend/Dockerfile — add before EXPOSE:
       RUN chmod +x /app/entrypoint.sh
       ENTRYPOINT ["/app/entrypoint.sh"]
     and keep the existing CMD line.

  4. Create the vault secrets + grant the principal:
       see references/vault-setup.md

  5. Verify WITHOUT disturbing the other apps on this host:
       see references/verify.md

  6. Paste templates/README-section.md into the app README and fill in the tables.

NEXT
