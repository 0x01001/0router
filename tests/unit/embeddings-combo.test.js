// /v1/embeddings used to reject combo names ("Invalid model format"), so an
// embedding model could not be given a fallback chain. A combo now walks its
// members with the same per-model account fallback as a direct request.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handleEmbeddingsCore: vi.fn(),
  getComboModels: vi.fn(),
  settings: { requireApiKey: false },
}));

vi.mock("../../src/sse/services/auth.js", () => ({
  getProviderCredentials: async (provider, excluded) => (excluded.size
    ? null
    : { apiKey: "k", connectionId: `conn-${provider}`, connectionName: provider }),
  markAccountUnavailable: async () => ({ shouldFallback: false }),
  clearAccountError: vi.fn(),
  extractApiKey: () => null,
  isValidApiKey: vi.fn(),
}));
vi.mock("@/lib/localDb", () => ({ getSettings: async () => mocks.settings }));
vi.mock("../../src/sse/services/model.js", () => ({
  getModelInfo: async (modelStr) => {
    const [provider, ...rest] = modelStr.split("/");
    return rest.length ? { provider, model: rest.join("/") } : { provider: null, model: modelStr };
  },
  getComboModels: mocks.getComboModels,
}));
vi.mock("../../open-sse/handlers/embeddingsCore.js", () => ({
  handleEmbeddingsCore: mocks.handleEmbeddingsCore,
}));
vi.mock("../../src/sse/utils/logger.js", () => ({
  request: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(), maskKey: vi.fn(),
}));
vi.mock("../../src/sse/services/tokenRefresh.js", () => ({
  updateProviderCredentials: vi.fn(),
  checkAndRefreshToken: async (_provider, credentials) => credentials,
}));
vi.mock("@/lib/usageDb.js", () => ({ saveRequestUsage: vi.fn().mockResolvedValue(undefined) }));

import { handleEmbeddings } from "../../src/sse/handlers/embeddings.js";

const ok = (model) => ({
  success: true,
  usage: { prompt_tokens: 2, total_tokens: 2 },
  response: Response.json({ object: "list", data: [{ embedding: [0.1] }], model }),
});
const fail = (status, message) => ({
  success: false,
  status,
  error: message,
  response: Response.json({ error: { message } }, { status }),
});

const embed = (model) => handleEmbeddings(new Request("http://localhost/v1/embeddings", {
  method: "POST",
  body: JSON.stringify({ model, input: "xin chào", input_type: "query" }),
}));

describe("handleEmbeddings — combos", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.settings = { requireApiKey: false };
    mocks.getComboModels.mockImplementation(async (m) =>
      m === "embed-combo" ? ["nvidia/nvidia/nemotron-3-embed-1b", "openai/text-embedding-3-small"] : null);
  });

  it("serves a combo with its first member", async () => {
    mocks.handleEmbeddingsCore.mockImplementation(async ({ modelInfo }) => ok(modelInfo.model));

    const res = await embed("embed-combo");

    expect(res.status).toBe(200);
    expect(mocks.handleEmbeddingsCore).toHaveBeenCalledTimes(1);
    const call = mocks.handleEmbeddingsCore.mock.calls[0][0];
    expect(call.modelInfo).toEqual({ provider: "nvidia", model: "nvidia/nemotron-3-embed-1b" });
    // client extras (input_type) still reach the core for passthrough
    expect(call.body.input_type).toBe("query");
  });

  it("falls through to the next member when the first one fails", async () => {
    mocks.handleEmbeddingsCore
      .mockResolvedValueOnce(fail(503, "upstream down"))
      .mockImplementationOnce(async ({ modelInfo }) => ok(modelInfo.model));

    const res = await embed("embed-combo");

    expect(res.status).toBe(200);
    expect(mocks.handleEmbeddingsCore.mock.calls.map((c) => c[0].modelInfo.provider)).toEqual(["nvidia", "openai"]);
    expect((await res.json()).model).toBe("text-embedding-3-small");
  });

  it("treats a fusion strategy as plain fallback", async () => {
    mocks.settings = { requireApiKey: false, comboStrategies: { "embed-combo": { fallbackStrategy: "fusion" } } };
    mocks.handleEmbeddingsCore.mockImplementation(async ({ modelInfo }) => ok(modelInfo.model));

    const res = await embed("embed-combo");

    expect(res.status).toBe(200);
    expect(mocks.handleEmbeddingsCore).toHaveBeenCalledTimes(1);
  });

  it("still rejects an unknown bare name", async () => {
    const res = await embed("not-a-combo");

    expect(res.status).toBe(400);
    expect(mocks.handleEmbeddingsCore).not.toHaveBeenCalled();
  });
});
