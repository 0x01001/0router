// Resolves the Codex CLI version 9router presents to chatgpt.com/backend-api/codex
// (Version / User-Agent / client_version). The backend gates newer models on this
// value, so a stale hardcoded version surfaces as "model is not supported when
// using Codex with a ChatGPT account". Resolution order:
//   1. env CODEX_CLI_VERSION (explicit pin — also disables auto-detection)
//   2. max(local `codex --version`, npm registry latest of @openai/codex)
//   3. registry fallback (providers/registry/codex.js cliVersion)
// Fail-open: any detection error keeps the last known good version.
import { PROVIDERS } from "../config/providers.js";

const FALLBACK_VERSION = PROVIDERS.codex?.cliVersion || "0.0.0";
const NPM_LATEST_URL = "https://registry.npmjs.org/@openai/codex/latest";
const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
const FAILURE_RETRY_MS = 10 * 60 * 1000;
const DETECT_TIMEOUT_MS = 3000;
const SEMVER_RE = /(\d+)\.(\d+)\.(\d+)/;

let cachedVersion = null;
let nextRefreshAt = 0;
let inflight = null;

function parseVersion(text) {
  const m = typeof text === "string" ? text.match(SEMVER_RE) : null;
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

export function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
  }
  return 0;
}

function envVersion() {
  return parseVersion(process.env.CODEX_CLI_VERSION);
}

async function detectLocalVersion() {
  try {
    const { execFile } = await import("node:child_process");
    return await new Promise((resolve) => {
      // shell:true so Windows resolves the npm `codex.cmd` shim; the command is a constant.
      execFile("codex --version", { timeout: DETECT_TIMEOUT_MS, shell: true, windowsHide: true }, (err, stdout) => {
        resolve(err ? null : parseVersion(stdout));
      });
    });
  } catch {
    return null;
  }
}

async function detectNpmLatestVersion() {
  if (process.env.CODEX_CLI_VERSION_NO_NETWORK === "1") return null;
  try {
    const res = await fetch(NPM_LATEST_URL, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(DETECT_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return parseVersion(data?.version);
  } catch {
    return null;
  }
}

async function resolveVersion() {
  const [local, latest] = await Promise.all([detectLocalVersion(), detectNpmLatestVersion()]);
  const candidates = [cachedVersion, FALLBACK_VERSION, local, latest].filter(Boolean);
  const best = candidates.reduce((a, b) => (compareVersions(b, a) > 0 ? b : a));
  const detected = Boolean(local || latest);
  cachedVersion = best;
  nextRefreshAt = Date.now() + (detected ? REFRESH_INTERVAL_MS : FAILURE_RETRY_MS);
  return best;
}

/** Synchronous accessor — last resolved version (or env pin / fallback before first resolve). */
export function getCodexCliVersion() {
  return envVersion() || cachedVersion || FALLBACK_VERSION;
}

export function getCodexUserAgent() {
  return `codex_cli_rs/${getCodexCliVersion()}`;
}

/** Resolve (at most once per refresh window) and return the version. Never throws. */
export async function ensureCodexCliVersion() {
  const pinned = envVersion();
  if (pinned) return pinned;
  if (cachedVersion && Date.now() < nextRefreshAt) return cachedVersion;
  if (!inflight) {
    inflight = resolveVersion()
      .catch(() => getCodexCliVersion())
      .finally(() => { inflight = null; });
  }
  return inflight;
}

// Test hook
export function _resetCodexCliVersionCache() {
  cachedVersion = null;
  nextRefreshAt = 0;
  inflight = null;
}
