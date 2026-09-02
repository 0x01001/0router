#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/lib/node_modules/9router}"
DATA_DIR="${DATA_DIR:-$HOME/.9router}"
PORT="${PORT:-20128}"
NODE_BIN="${NODE_BIN:-$HOME/.hermes/node/bin/node}"
RUN_TESTS="${RUN_TESTS:-1}"
AUTO_INSTALL_DEPS="${AUTO_INSTALL_DEPS:-1}"
REQUIRE_CURSOR_CONTENT="${REQUIRE_CURSOR_CONTENT:-0}"
PRESERVE_PREVIOUS_STATIC="${PRESERVE_PREVIOUS_STATIC:-1}"
STOP_TIMEOUT="${STOP_TIMEOUT:-20}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-45}"
DRY_RUN=0

SOURCE_APP="$ROOT_DIR/cli/app"
SOURCE_CLI="$ROOT_DIR/cli/cli.js"
INSTALLED_APP="$INSTALL_DIR/app"
STAGING_APP="$INSTALL_DIR/app.release-new"
LOCAL_RELEASE_FILE_NAME=".local-release.json"
CLI_JS="$INSTALL_DIR/cli.js"
BACKUP_ROOT="$DATA_DIR/update"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="$BACKUP_ROOT/manual-code-backup-$STAMP"
RELEASE_LOG="$BACKUP_DIR/release.log"
FAILED_APP=""
SWAP_DONE=0
RELEASE_OK=0
OLD_CLI_WAS_RUNNING=0
SERVICE_STOPPED=0
CLI_UPDATED=0
OLD_CLI_COMMAND=""
BASE_VERSION=""
CURRENT_PATCH_NUMBER=0
NEXT_PATCH_NUMBER=0
DISPLAY_VERSION=""

usage() {
  cat <<'EOF'
Usage: scripts/release-local.sh [--dry-run]

Build and deploy the local 9Router CLI server bundle. The script preserves
~/.9router data, creates a timestamped code backup, restarts the existing CLI,
and automatically rolls back if the new server fails its health checks.

Environment overrides:
  INSTALL_DIR, DATA_DIR, PORT, NODE_BIN
  RUN_TESTS=0|1
  AUTO_INSTALL_DEPS=0|1
  REQUIRE_CURSOR_CONTENT=0|1
  PRESERVE_PREVIOUS_STATIC=0|1
  STOP_TIMEOUT=<seconds>
  HEALTH_TIMEOUT=<seconds>
  CURSOR_DEFAULT_UPSTREAM_MODEL=<upstream model>
  NINEROUTER_API_KEY=<key for optional strict Cursor content probe>
EOF
}

log() {
  printf '[release] %s\n' "$*"
}

fail() {
  log "ERROR: $*"
  exit 1
}

quote_command() {
  local output=""
  local arg
  for arg in "$@"; do
    printf -v output '%s%q ' "$output" "$arg"
  done
  printf '%s' "${output% }"
}

require_integer() {
  local name="$1"
  local value="$2"
  [[ "$value" =~ ^[0-9]+$ ]] || fail "$name must be a non-negative integer; received: $value"
}

validate_safe_path() {
  local name="$1"
  local value="$2"
  [[ -n "$value" && "$value" == /* && "$value" != "/" ]] || fail "$name must be a non-root absolute path: $value"
}

read_package_version() {
  "$NODE_BIN" -e '
    const fs = require("fs");
    const pkg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (typeof pkg.version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(pkg.version)) process.exit(1);
    process.stdout.write(pkg.version);
  ' "$ROOT_DIR/package.json"
}

read_installed_patch_number() {
  local marker="$INSTALLED_APP/$LOCAL_RELEASE_FILE_NAME"
  [[ -f "$marker" ]] || {
    printf '0'
    return 0
  }

  "$NODE_BIN" -e '
    const fs = require("fs");
    try {
      const marker = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const expectedVersion = process.argv[2];
      const patch = marker.patchNumber;
      process.stdout.write(
        marker.version === expectedVersion && Number.isSafeInteger(patch) && patch > 0
          ? String(patch)
          : "0"
      );
    } catch {
      process.stdout.write("0");
    }
  ' "$marker" "$BASE_VERSION"
}

prepare_local_release_version() {
  BASE_VERSION="$(read_package_version)" || fail "Could not read a valid semantic version from $ROOT_DIR/package.json"
  CURRENT_PATCH_NUMBER="$(read_installed_patch_number)"
  [[ "$CURRENT_PATCH_NUMBER" =~ ^[0-9]+$ ]] || fail "Invalid installed local patch number: $CURRENT_PATCH_NUMBER"
  NEXT_PATCH_NUMBER=$((CURRENT_PATCH_NUMBER + 1))
  DISPLAY_VERSION="v$BASE_VERSION patch #$NEXT_PATCH_NUMBER"
  export NEXT_PUBLIC_LOCAL_PATCH_NUMBER="$NEXT_PATCH_NUMBER"
}

commit_release_metadata() {
  local marker="$INSTALLED_APP/$LOCAL_RELEASE_FILE_NAME"
  printf '{\n  "version": "%s",\n  "patchNumber": %s,\n  "displayVersion": "%s",\n  "releasedAt": "%s"\n}\n' \
    "$BASE_VERSION" "$NEXT_PATCH_NUMBER" "$DISPLAY_VERSION" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$marker"
}

install_cli_launcher() {
  local staged_cli="$INSTALL_DIR/cli.js.release-new"
  cp -p -- "$SOURCE_CLI" "$staged_cli"
  mv -f -- "$staged_cli" "$CLI_JS"
  CLI_UPDATED=1
}

port_listener_pids() {
  lsof -nP -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | sort -u || true
}

cli_pids() {
  local pid command
  while IFS= read -r pid; do
    [[ -n "$pid" ]] || continue
    command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
    [[ "$command" == *"$CLI_JS"* ]] && printf '%s\n' "$pid"
  done < <(pgrep -f "$CLI_JS" 2>/dev/null || true)
}

capture_cli_state() {
  local pids pid
  pids="$(cli_pids)"
  [[ -n "$pids" ]] || return 0

  if [[ "$(printf '%s\n' "$pids" | sed '/^$/d' | wc -l | tr -d ' ')" -ne 1 ]]; then
    fail "Expected at most one CLI launcher for $CLI_JS; found: $(printf '%s' "$pids" | tr '\n' ' ')"
  fi

  pid="$pids"
  OLD_CLI_COMMAND="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  [[ -n "$OLD_CLI_COMMAND" ]] || fail "Could not capture command for CLI PID $pid"
  OLD_CLI_WAS_RUNNING=1
  log "Detected running CLI PID $pid"
}

wait_for_port_free() {
  local deadline=$((SECONDS + STOP_TIMEOUT))
  while [[ "$SECONDS" -lt "$deadline" ]]; do
    [[ -z "$(port_listener_pids)" ]] && return 0
    sleep 1
  done
  return 1
}

wait_for_health() {
  local deadline=$((SECONDS + HEALTH_TIMEOUT))
  local status
  while [[ "$SECONDS" -lt "$deadline" ]]; do
    status="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 3 "http://127.0.0.1:$PORT/v1/models" || true)"
    [[ "$status" == "200" ]] && return 0
    sleep 1
  done
  return 1
}

start_cli() {
  local -a command
  if [[ "$OLD_CLI_WAS_RUNNING" -eq 1 ]]; then
    command=("$NODE_BIN" "$CLI_JS" --tray --skip-update --port "$PORT")
  else
    command=("$NODE_BIN" "$CLI_JS" --tray --skip-update --port "$PORT")
  fi

  log "Starting: $(quote_command "${command[@]}")"
  (
    cd "$INSTALL_DIR"
    nohup "${command[@]}" >> "$DATA_DIR/log.txt" 2>&1 </dev/null &
  )
}

stop_current_instance() {
  local pids pid
  pids="$(cli_pids)"
  if [[ -n "$pids" ]]; then
    log "Stopping CLI launcher PID(s): $(printf '%s' "$pids" | tr '\n' ' ')"
    while IFS= read -r pid; do
      [[ -n "$pid" ]] && kill -TERM "$pid" 2>/dev/null || true
    done <<< "$pids"
  else
    log "No CLI launcher found; checking port $PORT directly"
  fi

  if wait_for_port_free; then
    log "Port $PORT is free"
    return 0
  fi

  fail "Port $PORT did not become free within ${STOP_TIMEOUT}s; refusing to replace a live bundle"
}

ensure_build_dependencies() {
  local root_missing=0
  local cli_missing=0

  [[ -x "$ROOT_DIR/node_modules/.bin/next" ]] || root_missing=1
  [[ -x "$ROOT_DIR/cli/node_modules/.bin/esbuild" ]] || cli_missing=1

  if [[ "$root_missing" -eq 0 && "$cli_missing" -eq 0 ]]; then
    log "Build dependencies are present"
    return 0
  fi

  if [[ "$AUTO_INSTALL_DEPS" != "1" ]]; then
    fail "Build dependencies are missing; run npm install in the repo and cli directory, or use AUTO_INSTALL_DEPS=1"
  fi

  if [[ "$root_missing" -eq 1 ]]; then
    log "Installing missing root build dependencies"
    (
      cd "$ROOT_DIR"
      npm install --include=dev --no-package-lock --no-audit --no-fund
    )
  fi

  if [[ "$cli_missing" -eq 1 ]]; then
    log "Installing missing CLI build dependencies"
    npm --prefix "$ROOT_DIR/cli" install --include=dev --no-package-lock --no-audit --no-fund
  fi

  [[ -x "$ROOT_DIR/node_modules/.bin/next" ]] || fail "Next.js binary is still missing after dependency install"
  [[ -x "$ROOT_DIR/cli/node_modules/.bin/esbuild" ]] || fail "CLI esbuild binary is still missing after dependency install"
}

verify_built_bundle() {
  [[ -f "$SOURCE_APP/custom-server.js" ]] || fail "Missing built custom server: $SOURCE_APP/custom-server.js"
  [[ -f "$SOURCE_APP/.next-cli-build/server/app/api/v1/chat/completions/route.js" ]] || \
    fail "Missing built chat completion route"
  [[ -d "$SOURCE_APP/.next-cli-build/static" ]] || fail "Missing built Next.js static assets"

  local material_font
  material_font="$(find "$SOURCE_APP/.next-cli-build/static/media" -maxdepth 1 -type f \
    -name 'material-symbols-outlined.*.woff2' -print -quit 2>/dev/null || true)"
  [[ -n "$material_font" ]] || fail "Missing built Material Symbols icon font"

  if ! grep -RIl --include='*.js' 'empty_completion' "$SOURCE_APP/.next-cli-build/server" >/dev/null 2>&1; then
    fail "Built bundle does not contain the empty_completion Cursor patch marker"
  fi
}

preserve_previous_static_assets() {
  local old_static="$INSTALLED_APP/.next-cli-build/static"
  local new_static="$STAGING_APP/.next-cli-build/static"
  local old_manifest="$INSTALLED_APP/.release-current-static-files"
  local current_manifest="$STAGING_APP/.release-current-static-files"
  local relative source target copied=0

  (
    cd "$new_static"
    find . -type f -print | LC_ALL=C sort
  ) > "$current_manifest"

  [[ "$PRESERVE_PREVIOUS_STATIC" == "1" ]] || {
    log "Previous static asset compatibility is disabled"
    return 0
  }
  [[ -d "$old_static" ]] || return 0

  if [[ -f "$old_manifest" ]]; then
    while IFS= read -r relative; do
      relative="${relative#./}"
      [[ -n "$relative" && "$relative" != /* && "$relative" != ".." && "$relative" != ../* && "$relative" != */../* ]] || \
        fail "Unsafe path in previous static manifest: $relative"
      source="$old_static/$relative"
      target="$new_static/$relative"
      [[ -f "$source" && ! -e "$target" ]] || continue
      mkdir -p -- "$(dirname -- "$target")"
      cp -p -- "$source" "$target"
      copied=$((copied + 1))
    done < "$old_manifest"
  else
    while IFS= read -r -d '' source; do
      relative="${source#"$old_static"/}"
      target="$new_static/$relative"
      [[ ! -e "$target" ]] || continue
      mkdir -p -- "$(dirname -- "$target")"
      cp -p -- "$source" "$target"
      copied=$((copied + 1))
    done < <(find "$old_static" -type f -print0)
  fi

  log "Preserved $copied previous-generation static asset(s) for already-open browser tabs"
}

stage_bundle() {
  [[ ! -e "$STAGING_APP" ]] || rm -rf -- "$STAGING_APP"
  log "Staging built bundle at $STAGING_APP"
  cp -a -- "$SOURCE_APP" "$STAGING_APP"
  [[ -f "$STAGING_APP/custom-server.js" ]] || fail "Staged bundle is incomplete"
  preserve_previous_static_assets
}

strict_cursor_probe() {
  local response_file="$BACKUP_DIR/cursor-probe.sse"
  local key="${NINEROUTER_API_KEY:-}"

  [[ "$REQUIRE_CURSOR_CONTENT" == "1" ]] || return 0
  [[ -n "$key" ]] || fail "REQUIRE_CURSOR_CONTENT=1 requires NINEROUTER_API_KEY in the environment"

  log "Running strict cu/default content probe"
  curl --silent --show-error --no-buffer --max-time 45 \
    --request POST \
    --url "http://127.0.0.1:$PORT/v1/chat/completions" \
    --header "Authorization: Bearer $key" \
    --header 'Content-Type: application/json' \
    --data-raw '{"model":"cu/default","stream":true,"temperature":0,"messages":[{"role":"user","content":"Translate into Vietnamese. Return only the translation: Hello, this is a streaming response test."}]}' \
    --output "$response_file"

  "$NODE_BIN" "$ROOT_DIR/scripts/verify-cursor-release-sse.mjs" "$response_file"
}

rollback() {
  local cause_status="$?"
  trap - ERR INT TERM EXIT

  [[ "$RELEASE_OK" -eq 0 ]] || exit "$cause_status"

  if [[ "$SWAP_DONE" -eq 0 ]]; then
    if [[ "$SERVICE_STOPPED" -eq 1 && "$OLD_CLI_WAS_RUNNING" -eq 1 ]]; then
      log "Release failed after stopping the old server; restarting the unchanged bundle"
      start_cli || true
      if wait_for_health; then
        log "Previous server restarted successfully"
      else
        log "ERROR: previous bundle was unchanged but could not be restarted"
      fi
    fi
    exit "$cause_status"
  fi

  log "Release failed after bundle swap; rolling back"

  if [[ "$CLI_UPDATED" -eq 1 && -f "$BACKUP_DIR/cli.js" ]]; then
    cp -p -- "$BACKUP_DIR/cli.js" "$CLI_JS"
    CLI_UPDATED=0
  fi

  local pids pid
  pids="$(cli_pids)"
  if [[ -n "$pids" ]]; then
    while IFS= read -r pid; do
      [[ -n "$pid" ]] && kill -TERM "$pid" 2>/dev/null || true
    done <<< "$pids"
    wait_for_port_free || true
  fi

  FAILED_APP="$INSTALL_DIR/app.failed-$STAMP"
  if [[ -e "$INSTALLED_APP" ]]; then
    mv -- "$INSTALLED_APP" "$FAILED_APP"
  fi
  if [[ -e "$BACKUP_DIR/app" ]]; then
    mv -- "$BACKUP_DIR/app" "$INSTALLED_APP"
  else
    log "ERROR: rollback backup is missing: $BACKUP_DIR/app"
    exit "$cause_status"
  fi

  if [[ "$OLD_CLI_WAS_RUNNING" -eq 1 ]]; then
    start_cli || true
    if wait_for_health; then
      log "Rollback succeeded; previous server is healthy"
    else
      log "ERROR: previous bundle was restored but health check still failed"
    fi
  else
    log "Previous instance was not running; restored bundle without starting it"
  fi

  exit "$cause_status"
}

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; fail "Unknown argument: $arg" ;;
  esac
done

require_integer PORT "$PORT"
require_integer STOP_TIMEOUT "$STOP_TIMEOUT"
require_integer HEALTH_TIMEOUT "$HEALTH_TIMEOUT"
[[ "$RUN_TESTS" == "0" || "$RUN_TESTS" == "1" ]] || fail "RUN_TESTS must be 0 or 1"
[[ "$AUTO_INSTALL_DEPS" == "0" || "$AUTO_INSTALL_DEPS" == "1" ]] || fail "AUTO_INSTALL_DEPS must be 0 or 1"
[[ "$REQUIRE_CURSOR_CONTENT" == "0" || "$REQUIRE_CURSOR_CONTENT" == "1" ]] || fail "REQUIRE_CURSOR_CONTENT must be 0 or 1"
[[ "$PRESERVE_PREVIOUS_STATIC" == "0" || "$PRESERVE_PREVIOUS_STATIC" == "1" ]] || fail "PRESERVE_PREVIOUS_STATIC must be 0 or 1"
validate_safe_path INSTALL_DIR "$INSTALL_DIR"
validate_safe_path DATA_DIR "$DATA_DIR"
validate_safe_path NODE_BIN "$NODE_BIN"
[[ "$INSTALL_DIR" != "$DATA_DIR" && "$INSTALL_DIR" != "$DATA_DIR/"* ]] || fail "INSTALL_DIR must not be inside DATA_DIR"
[[ -d "$ROOT_DIR/.git" ]] || fail "Not a git checkout: $ROOT_DIR"
[[ -f "$ROOT_DIR/package.json" ]] || fail "Missing root package.json"
[[ -f "$SOURCE_CLI" ]] || fail "Missing source CLI launcher: $SOURCE_CLI"
[[ -x "$NODE_BIN" ]] || fail "Node binary is not executable: $NODE_BIN"
[[ -d "$INSTALL_DIR" ]] || fail "Installed 9Router directory does not exist: $INSTALL_DIR"
[[ -f "$CLI_JS" ]] || fail "Installed 9Router CLI is missing: $CLI_JS"
[[ -d "$INSTALLED_APP" ]] || fail "Installed 9Router app bundle is missing: $INSTALLED_APP"
[[ -d "$DATA_DIR" ]] || fail "9Router data directory does not exist: $DATA_DIR"
command -v npm >/dev/null || fail "npm is required"
command -v curl >/dev/null || fail "curl is required"
command -v lsof >/dev/null || fail "lsof is required"
command -v pgrep >/dev/null || fail "pgrep is required"
[[ -w "$INSTALL_DIR" ]] || fail "Installed 9Router directory is not writable: $INSTALL_DIR"
[[ -w "$BACKUP_ROOT" || -w "$DATA_DIR" ]] || fail "Backup location is not writable: $BACKUP_ROOT"

capture_cli_state
prepare_local_release_version

if [[ "$DRY_RUN" -eq 1 ]]; then
  cat <<EOF
[release] DRY RUN — no tests, build, process signals, writes, or swaps were performed.
[release] Repository:       $ROOT_DIR
[release] Source bundle:    $SOURCE_APP
[release] Source CLI:       $SOURCE_CLI
[release] Installed bundle: $INSTALLED_APP
[release] Staging bundle:   $STAGING_APP
[release] Backup directory: $BACKUP_DIR
[release] Data directory:   $DATA_DIR (preserved)
[release] Port:             $PORT
[release] Node:             $NODE_BIN
[release] Run tests:        $RUN_TESTS
[release] Auto-install deps: $AUTO_INSTALL_DEPS
[release] Strict Cursor:    $REQUIRE_CURSOR_CONTENT
[release] Preserve static:  $PRESERVE_PREVIOUS_STATIC (one previous generation)
[release] Current patch:    $CURRENT_PATCH_NUMBER (0 means unnumbered)
[release] Next release:     $DISPLAY_VERSION
[release] CLI running:      $OLD_CLI_WAS_RUNNING
EOF
  exit 0
fi

mkdir -p -- "$BACKUP_DIR"
exec > >(tee -a "$RELEASE_LOG") 2>&1
trap rollback ERR INT TERM EXIT

log "Repository: $ROOT_DIR"
log "Installed bundle: $INSTALLED_APP"
log "Backup: $BACKUP_DIR"
log "Local release: $DISPLAY_VERSION"
log "Database, credentials, and MITM state under $DATA_DIR will be preserved"

ensure_build_dependencies

if [[ "$RUN_TESTS" == "1" ]]; then
  log "Running targeted Cursor tests"
  (
    cd "$ROOT_DIR"
    npm exec --yes --package=vitest -- vitest run \
      tests/unit/cursor-default.test.js \
      tests/unit/cursor-composer-thinking.test.js \
      tests/unit/cursor-agent-exec-request.test.js
  )
else
  log "WARNING: tests skipped because RUN_TESTS=0"
fi

log "Building production CLI bundle"
(
  cd "$ROOT_DIR"
  npm --prefix cli run build
)
verify_built_bundle
stage_bundle

capture_cli_state
stop_current_instance
SERVICE_STOPPED=1

log "Backing up installed bundle"
mv -- "$INSTALLED_APP" "$BACKUP_DIR/app"
SWAP_DONE=1
mv -- "$STAGING_APP" "$INSTALLED_APP"
cp -- "$INSTALL_DIR/package.json" "$BACKUP_DIR/package.json"
cp -- "$CLI_JS" "$BACKUP_DIR/cli.js"
printf '%s\n' "$OLD_CLI_COMMAND" > "$BACKUP_DIR/previous-command.txt"

start_cli
if ! wait_for_health; then
  fail "New server did not return HTTP 200 from /v1/models within ${HEALTH_TIMEOUT}s"
fi
log "Server health check passed"

if ! curl --silent --show-error --max-time 10 "http://127.0.0.1:$PORT/v1/models" | \
  node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{try{const j=JSON.parse(s);const ok=(j.data||[]).some(x=>x.id==='cu/default');process.exit(ok?0:1)}catch{process.exit(1)}})"; then
  fail "Model catalog does not expose cu/default"
fi
log "Model catalog exposes cu/default"

strict_cursor_probe

install_cli_launcher
commit_release_metadata
RELEASE_OK=1
trap - ERR INT TERM EXIT
log "Release completed successfully"
log "Installed $DISPLAY_VERSION"
log "Backup retained at: $BACKUP_DIR"
log "Note: npm i -g 9router@latest may overwrite this patched bundle"
