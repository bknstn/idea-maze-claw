#!/bin/bash
#
# Verify, push, deploy, and smoke test the VPS from trunk (`main`).
#
# Usage:
#   ./scripts/ship-main.sh
#   ./scripts/ship-main.sh idea-maze-vps
#   ./scripts/ship-main.sh --fail-on-dirty-remote
#   ./scripts/ship-main.sh --stash-local
#   ./scripts/ship-main.sh --skip-verify --no-monitor
#   ./scripts/ship-main.sh --dry-run

set -euo pipefail

HOST_ALIAS="idea-maze-vps"
APP_DIR="/root/idea-maze-claw"
SERVICE_NAME="nanoclaw"
REMOTE_DIRTY_MODE="stash"
LOCAL_DIRTY_MODE="fail"
RUN_VERIFY="true"
RUN_MONITOR="true"
DRY_RUN="false"

usage() {
  cat <<'EOF'
Usage: ./scripts/ship-main.sh [ssh-host-alias] [options]

Defaults:
  ssh-host-alias: idea-maze-vps
  remote app dir: /root/idea-maze-claw
  service name:   nanoclaw
  local dirty:    fail
  remote dirty:   stash tracked changes before deploy

Options:
  --stash-local          Stash local tracked + untracked changes before shipping
  --skip-verify          Skip local `npm run verify`
  --no-monitor           Skip the final `monitor-vps.sh` summary
  --fail-on-dirty-remote Fail instead of stashing tracked remote changes
  --app-dir <path>       Override the remote repo path
  --service <name>       Override the remote service name
  --dry-run              Print the steps without executing them
  -h, --help             Show this help text
EOF
}

require_value() {
  local option="$1"
  local value="${2:-}"
  if [ -z "$value" ]; then
    echo "Missing value for $option" >&2
    usage >&2
    exit 1
  fi
}

run_cmd() {
  printf '+'
  for arg in "$@"; do
    printf ' %q' "$arg"
  done
  printf '\n'

  if [ "$DRY_RUN" = "false" ]; then
    "$@"
  fi
}

assert_on_main() {
  local branch
  branch="$(git branch --show-current)"
  if [ "$branch" != "main" ]; then
    echo "ship-main.sh expects the current branch to be 'main' (got '$branch')." >&2
    exit 1
  fi
}

assert_clean_tree() {
  if ! git diff --quiet || ! git diff --cached --quiet || [ -n "$(git ls-files --others --exclude-standard)" ]; then
    echo "Working tree is not clean. Commit or stash changes before shipping main." >&2
    git status --short >&2
    exit 1
  fi
}

stash_local_tree() {
  if git diff --quiet && git diff --cached --quiet && [ -z "$(git ls-files --others --exclude-standard)" ]; then
    return
  fi

  local stash_label
  stash_label="pre-ship-local-$(date -u +%Y%m%dT%H%M%SZ)-$(git rev-parse --short HEAD)"
  run_cmd git stash push --include-untracked -m "$stash_label"
}

run_remote_deploy() {
  if [ "$DRY_RUN" = "true" ]; then
    printf '+ ssh %q bash -s -- %q %q %q <remote deploy script>\n' \
      "$HOST_ALIAS" "$APP_DIR" "$SERVICE_NAME" "$REMOTE_DIRTY_MODE"
    return
  fi

  ssh "$HOST_ALIAS" bash -s -- "$APP_DIR" "$SERVICE_NAME" "$REMOTE_DIRTY_MODE" <<'REMOTE'
set -euo pipefail

APP_DIR="$1"
SERVICE_NAME="$2"
REMOTE_DIRTY_MODE="$3"

cd "$APP_DIR"

printf 'Remote HEAD before deploy: '
git rev-parse --short HEAD

dirty_tracked="$(git status --short --untracked-files=no)"
if [ -n "$dirty_tracked" ]; then
  echo "Remote tracked changes detected:"
  printf '%s\n' "$dirty_tracked"

  if [ "$REMOTE_DIRTY_MODE" = "fail" ]; then
    echo "Refusing to deploy over a dirty remote worktree." >&2
    exit 1
  fi

  stash_label="pre-deploy-$(date -u +%Y%m%dT%H%M%SZ)-$(git rev-parse --short HEAD)"
  git stash push -m "$stash_label"
  echo "Stashed tracked remote changes as: $stash_label"
fi

git pull --ff-only origin main
npm run build
systemctl restart "$SERVICE_NAME"
systemctl is-active "$SERVICE_NAME" >/dev/null
npx tsx setup/index.ts --step verify

printf 'Remote HEAD after deploy: '
git rev-parse --short HEAD
REMOTE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --skip-verify)
      RUN_VERIFY="false"
      ;;
    --stash-local)
      LOCAL_DIRTY_MODE="stash"
      ;;
    --no-monitor)
      RUN_MONITOR="false"
      ;;
    --fail-on-dirty-remote)
      REMOTE_DIRTY_MODE="fail"
      ;;
    --app-dir)
      require_value "$1" "${2:-}"
      APP_DIR="$2"
      shift
      ;;
    --service)
      require_value "$1" "${2:-}"
      SERVICE_NAME="$2"
      shift
      ;;
    --dry-run)
      DRY_RUN="true"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      if [ "$HOST_ALIAS" = "idea-maze-vps" ]; then
        HOST_ALIAS="$1"
      else
        echo "Unexpected argument: $1" >&2
        usage >&2
        exit 1
      fi
      ;;
  esac
  shift
done

assert_on_main

if [ "$LOCAL_DIRTY_MODE" = "stash" ]; then
  stash_local_tree
else
  assert_clean_tree
fi

if [ "$RUN_VERIFY" = "true" ]; then
  run_cmd npm run verify
fi

run_cmd git push origin main
run_remote_deploy

if [ "$RUN_MONITOR" = "true" ]; then
  run_cmd bash ./scripts/monitor-vps.sh "$HOST_ALIAS"
fi
