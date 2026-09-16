#!/usr/bin/env bash
# =============================================================================
# scaffold.sh — create a new full-stack app from the bundled minimal-core
#               skeleton (Flask + PostgreSQL + React + Docker Compose).
# -----------------------------------------------------------------------------
# The skeleton lives beside this script at ../skeleton and is the single source
# of truth — files are COPIED, never regenerated from memory. What it does:
#   1. Validates prerequisites and that the target does not already exist.
#   2. Copies the bundled skeleton into the target directory.
#   3. Derives naming forms from ONE app name and substitutes the skeleton's
#      placeholder tokens (@@SLUG@@, @@PREFIX@@, @@NAME@@) in every text file.
#   4. Writes .env (from .env.example) and frontend/.env (from its example).
#   5. Initialises a fresh git repo with a single commit and prints next steps.
#
# It never overwrites an existing target and fails loudly on missing tools.
#
# Usage:
#   scaffold.sh <app_name> <target_dir> [--display "Display Name"]
#
# Arguments:
#   app_name     snake_case / hyphen / "Display style" — normalised internally.
#   target_dir   directory to create for the new app (must NOT already exist).
#
# Options:
#   --display "Acme CRM"   Human display name (default: title-cased app name).
#   -h | --help            Show this help.
#
# Example:
#   scaffold.sh acme_crm /tmp/acme_crm --display "Acme CRM"
# =============================================================================

set -euo pipefail

_grn=$'\033[32m'; _red=$'\033[31m'; _ylw=$'\033[33m'; _bold=$'\033[1m'; _rst=$'\033[0m'
info() { printf '%s==>%s %s\n' "$_grn" "$_rst" "$*"; }
warn() { printf '%s[warn]%s %s\n' "$_ylw" "$_rst" "$*" >&2; }
die()  { printf '%s[error]%s %s\n' "$_red" "$_rst" "$*" >&2; exit 1; }
usage() { sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

# ── parse args ───────────────────────────────────────────────────────────────
APP_NAME=""; TARGET_DIR=""; DISPLAY_NAME=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage 0 ;;
    --display) DISPLAY_NAME="${2:-}"; shift 2 ;;
    --*)       die "unknown option: $1 (see --help)" ;;
    *)
      if   [[ -z "$APP_NAME"   ]]; then APP_NAME="$1"
      elif [[ -z "$TARGET_DIR" ]]; then TARGET_DIR="$1"
      else die "unexpected extra argument: $1"; fi
      shift ;;
  esac
done

[[ -n "$APP_NAME"   ]] || die "missing <app_name> (see --help)"
[[ -n "$TARGET_DIR" ]] || die "missing <target_dir> (see --help)"

# ── locate the bundled skeleton ──────────────────────────────────────────────
_script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKELETON="$_script_dir/../skeleton"
[[ -d "$SKELETON" ]] || die "bundled skeleton not found at: $SKELETON"
[[ -f "$SKELETON/docker-compose.yml" ]] || die "skeleton looks incomplete: $SKELETON"

# ── prerequisites ────────────────────────────────────────────────────────────
command -v git >/dev/null 2>&1 || die "git is required but not on PATH"

# Never overwrite an existing target.
if [[ -e "$TARGET_DIR" ]]; then
  if [[ -d "$TARGET_DIR" && -z "$(ls -A "$TARGET_DIR" 2>/dev/null)" ]]; then
    warn "target exists but is empty; using it: $TARGET_DIR"
  else
    die "target already exists and is not empty: $TARGET_DIR
  Refusing to overwrite. Choose a different target directory."
  fi
fi

# ── derive naming forms ──────────────────────────────────────────────────────
# snake: lowercase, spaces/hyphens -> _, strip other junk, collapse underscores.
SLUG="$(printf '%s' "$APP_NAME" \
        | tr '[:upper:]' '[:lower:]' \
        | sed -E 's/[[:space:]-]+/_/g; s/[^a-z0-9_]//g; s/_+/_/g; s/^_//; s/_$//')"
[[ -n "$SLUG" ]] || die "app_name '$APP_NAME' normalises to empty; use letters/digits"

PREFIX="$(printf '%s' "$SLUG" | tr -d '_' | tr '[:lower:]' '[:upper:]')"   # ACMECRM
if [[ -z "$DISPLAY_NAME" ]]; then
  DISPLAY_NAME="$(printf '%s' "$SLUG" | tr '_' ' ' \
    | awk '{for(i=1;i<=NF;i++){$i=toupper(substr($i,1,1)) substr($i,2)}; print}')"
fi

info "app name    : $DISPLAY_NAME"
info "  slug      : $SLUG"
info "  env prefix: $PREFIX"
info "target dir  : $TARGET_DIR"

# ── copy the skeleton ────────────────────────────────────────────────────────
mkdir -p "$TARGET_DIR"
info "copying bundled skeleton…"
cp -a "$SKELETON/." "$TARGET_DIR/"

# ── substitute placeholder tokens in every text file ─────────────────────────
info "substituting @@SLUG@@ / @@PREFIX@@ / @@NAME@@ …"
_sed_script="s|@@SLUG@@|${SLUG}|g;s|@@PREFIX@@|${PREFIX}|g;s|@@NAME@@|${DISPLAY_NAME}|g;"
while IFS= read -r -d '' f; do
  if grep -Iq . "$f" 2>/dev/null; then      # -I: skip binaries
    sed -i "$_sed_script" "$f"
  fi
done < <(find "$TARGET_DIR" -type f -print0)

# ── environment files ────────────────────────────────────────────────────────
info "writing .env and frontend/.env from the examples…"
[[ -f "$TARGET_DIR/.env.example" ]] && cp "$TARGET_DIR/.env.example" "$TARGET_DIR/.env"
[[ -f "$TARGET_DIR/frontend/.env.example" ]] \
  && cp "$TARGET_DIR/frontend/.env.example" "$TARGET_DIR/frontend/.env"

# ── fresh git history ────────────────────────────────────────────────────────
info "initialising a fresh git repository…"
(
  cd "$TARGET_DIR"
  git init -q
  git add -A
  git -c user.name='scaffold' -c user.email='scaffold@localhost' \
    commit -q -m "Initial scaffold of ${DISPLAY_NAME}" || true
)

# ── done ─────────────────────────────────────────────────────────────────────
cat <<EOF

${_bold}${_grn}✔ Scaffolded ${DISPLAY_NAME} at ${TARGET_DIR}${_rst}

Next steps:
  1. cd ${TARGET_DIR}
  2. Review .env (set a real ${PREFIX}_DB_PASSWORD).
  3. docker compose up -d --build
  4. curl http://localhost:5100/api/health    # {"status":"healthy"}
  5. Open http://localhost:3100 and add an item.

Then grow the domain: edit database/sql_init.sql (+ the _SCHEMA_SQL block in
backend/app.py), add routes in backend/app.py, and pages in frontend/src/pages.
EOF
