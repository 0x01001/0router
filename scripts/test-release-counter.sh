#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RELEASE_SCRIPT="$ROOT_DIR/scripts/release-local.sh"
NODE_BIN="${NODE_BIN:-$HOME/.hermes/node/bin/node}"
TEMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/9router-release-counter.XXXXXX")"
INSTALL_DIR="$TEMP_ROOT/install"
DATA_DIR="$TEMP_ROOT/data"
MARKER="$INSTALL_DIR/app/.local-release.json"
FAKE_BIN="$TEMP_ROOT/bin"

cleanup() {
  rm -rf -- "$TEMP_ROOT"
}
trap cleanup EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

mkdir -p "$INSTALL_DIR/app" "$DATA_DIR" "$FAKE_BIN"
printf '#!/usr/bin/env node\n' > "$INSTALL_DIR/cli.js"
chmod +x "$INSTALL_DIR/cli.js"

run_dry() {
  INSTALL_DIR="$INSTALL_DIR" \
  DATA_DIR="$DATA_DIR" \
  NODE_BIN="$NODE_BIN" \
  PORT=49127 \
  AUTO_INSTALL_DEPS=0 \
  RUN_TESTS=0 \
    "$RELEASE_SCRIPT" --dry-run
}

write_marker() {
  local version="$1"
  local patch_number="$2"
  printf '{"version":"%s","patchNumber":%s}\n' "$version" "$patch_number" > "$MARKER"
}

output="$(run_dry)"
grep -Fq 'Next release:     v0.5.59 patch #1' <<< "$output" || fail "first release was not patch #1"
[[ ! -e "$MARKER" ]] || fail "dry-run created a release marker"

write_marker "0.5.59" 1
output="$(run_dry)"
grep -Fq 'Next release:     v0.5.59 patch #2' <<< "$output" || fail "second release was not patch #2"
grep -Fq '"patchNumber":1' "$MARKER" || fail "dry-run changed patch #1 marker"

write_marker "0.5.59" 2
output="$(run_dry)"
grep -Fq 'Next release:     v0.5.59 patch #3' <<< "$output" || fail "third release was not patch #3"
grep -Fq '"patchNumber":2' "$MARKER" || fail "dry-run changed patch #2 marker"

write_marker "0.5.58" 99
output="$(run_dry)"
grep -Fq 'Next release:     v0.5.59 patch #1' <<< "$output" || fail "base version change did not reset to patch #1"

write_marker "0.5.59" 7
cat > "$FAKE_BIN/npm" <<'EOF'
#!/usr/bin/env bash
exit 42
EOF
chmod +x "$FAKE_BIN/npm"

set +e
PATH="$FAKE_BIN:$PATH" \
INSTALL_DIR="$INSTALL_DIR" \
DATA_DIR="$DATA_DIR" \
NODE_BIN="$NODE_BIN" \
PORT=49127 \
AUTO_INSTALL_DEPS=0 \
RUN_TESTS=0 \
  "$RELEASE_SCRIPT" > "$TEMP_ROOT/failed-release.log" 2>&1
status=$?
set -e
[[ "$status" -ne 0 ]] || fail "simulated failed build unexpectedly succeeded"
grep -Fq '"patchNumber":7' "$MARKER" || fail "failed release changed the installed counter"

printf 'PASS: first=#1, sequential=#2/#3, dry-run=no write, semver reset=#1, failed build=no increment\n'
