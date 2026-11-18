import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.fn();
vi.mock("node:child_process", () => ({ execFile: (...args) => execFileMock(...args) }));

const mod = await import("../../open-sse/services/codexCliVersion.js");
const { PROVIDERS } = await import("../../open-sse/config/providers.js");
const FALLBACK = PROVIDERS.codex.cliVersion;

function localVersion(stdout, err = null) {
  execFileMock.mockImplementation((_cmd, _opts, cb) => cb(err, stdout));
}
function npmLatest(version, ok = true) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok, json: async () => ({ version }) });
}

beforeEach(() => { mod._resetCodexCliVersionCache(); execFileMock.mockReset(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("codexCliVersion", () => {
  it("env CODEX_CLI_VERSION pins the version without detection", async () => {
    vi.stubEnv("CODEX_CLI_VERSION", "1.2.3");
    const fetchSpy = npmLatest("9.0.0");
    expect(await mod.ensureCodexCliVersion()).toBe("1.2.3");
    expect(mod.getCodexUserAgent()).toBe("codex_cli_rs/1.2.3");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("picks the highest of local CLI and npm latest", async () => {
    localVersion("codex-cli 900.1.0\n");
    npmLatest("900.2.0");
    expect(await mod.ensureCodexCliVersion()).toBe("900.2.0");
    expect(mod.getCodexCliVersion()).toBe("900.2.0");
  });

  it("uses the local CLI when npm is unreachable", async () => {
    localVersion("codex-cli 900.3.1");
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    expect(await mod.ensureCodexCliVersion()).toBe("900.3.1");
  });

  it("never downgrades below the registry fallback and fails open", async () => {
    localVersion("", new Error("not installed"));
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    expect(await mod.ensureCodexCliVersion()).toBe(FALLBACK);
    mod._resetCodexCliVersionCache();
    localVersion("codex-cli 0.0.1");
    npmLatest("0.0.2");
    expect(await mod.ensureCodexCliVersion()).toBe(FALLBACK);
  });

  it("caches the resolved version within the refresh window", async () => {
    localVersion("codex-cli 900.0.0");
    const fetchSpy = npmLatest("900.0.0");
    await mod.ensureCodexCliVersion();
    await mod.ensureCodexCliVersion();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("compareVersions orders semver numerically", () => {
    expect(mod.compareVersions("0.169.1", "0.99.9")).toBe(1);
    expect(mod.compareVersions("0.1.0", "0.1.0")).toBe(0);
    expect(mod.compareVersions("0.1.0", "0.2.0")).toBe(-1);
  });
});
