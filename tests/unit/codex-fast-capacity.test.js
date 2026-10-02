import { describe, expect, it } from "vitest";
import { CodexExecutor } from "../../open-sse/executors/codex.js";
import { getModelQuotaFamily, getModelType, getModelUpstreamId } from "../../open-sse/config/providerModels.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { stripThinkingSuffix } from "../../open-sse/translator/concerns/thinkingUnified.js";
import "../translator/registerAll.js";
import { translateRequest } from "../../open-sse/translator/index.js";

function streamFromText(text) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

describe("Codex fast tier and capacity handling", () => {
  it("maps Codex fast tier to priority and max reasoning to xhigh", () => {
    const executor = new CodexExecutor();
    const body = executor.transformRequest("gpt-5.5", {
      model: "gpt-5.5",
      input: "hi",
      reasoning_effort: "max",
      service_tier: "fast",
    }, true, {});

    expect(body.service_tier).toBe("priority");
    expect(body.reasoning.effort).toBe("xhigh");
  });

  it("uses ChatGPT workspace header fallback", () => {
    const executor = new CodexExecutor();
    const headers = executor.buildHeaders({
      accessToken: "token",
      connectionId: "conn_1",
      providerSpecificData: { chatgptAccountId: "acct_1" },
    });

    expect(headers["ChatGPT-Account-ID"]).toBe("acct_1");
  });

  it("classifies 200-SSE model capacity as account fallback", async () => {
    const executor = new CodexExecutor();
    const response = new Response(streamFromText([
      "event: error",
      'data: {"error":{"message":"Selected model is at capacity. Please try a different model."}}',
      "",
    ].join("\n")), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });

    const peek = await executor._peekSseTransientError(response);
    expect(peek.accountFallback).toBe(true);
    expect(peek.message).toBe("Selected model is at capacity. Please try a different model.");
  });

  it("reassembles normal SSE after peeking", async () => {
    const executor = new CodexExecutor();
    const text = [
      "event: response.output_text.delta",
      'data: {"type":"response.output_text.delta","delta":"OK"}',
      "",
    ].join("\n");
    const response = new Response(streamFromText(text), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });

    const peek = await executor._peekSseTransientError(response);
    expect(peek.matched).toBeNull();
    await expect(new Response(peek.replacementBody).text()).resolves.toBe(text);
  });
});

describe("Codex reasoning normalization", () => {
  it.each([
    ["gpt-5.6-sol", "max", "max"],
    ["gpt-5.6-sol", "ultra", "ultra"],
    ["gpt-5.6-terra", "max", "max"],
    ["gpt-5.6-terra", "ultra", "ultra"],
    ["gpt-5.6-luna", "max", "max"],
    ["gpt-5.6-luna", "ultra", "max"],
  ])("normalizes %s effort %s to %s", (model, effort, expected) => {
    const body = new CodexExecutor().transformRequest(model, {
      model,
      input: "hi",
      reasoning: { effort },
    }, true, {});

    expect(body.reasoning.effort).toBe(expected);
  });

  it("resolves review models before applying the reasoning matrix", () => {
    const body = new CodexExecutor().transformRequest("gpt-5.6-terra-review", {
      model: "gpt-5.6-terra-review",
      input: "hi",
      reasoning_effort: "ultra",
    }, true, {});

    expect(body.model).toBe("gpt-5.6-terra");
    expect(body.reasoning.effort).toBe("ultra");
  });
});

// Mirrors chatCore: upstream id → translate → strip "(level)" → executor.
function sendCodex(model, extra = {}) {
  const upstream = getModelUpstreamId("cx", model);
  const translated = translateRequest(FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, upstream, {
    model: `cx/${model}`,
    messages: [{ role: "user", content: "hi" }],
    ...extra,
  }, true, {}, "codex");
  translated.model = stripThinkingSuffix(upstream);
  const executor = new CodexExecutor();
  const body = executor.transformRequest(translated.model, translated, true, { connectionId: "fast-test" });
  const headers = executor.buildHeaders({ connectionId: "fast-test" }, true, null, translated.model);
  return { body, headers };
}

describe("Codex Fast mode model suffix", () => {
  it.each([
    ["gpt-5.6-sol-high-fast", "gpt-5.6-sol", "high"],
    ["gpt-5.6-sol-fast", "gpt-5.6-sol", "low"],
    ["gpt-5.6-sol-max-fast", "gpt-5.6-sol", "max"],
    ["gpt-5.6-sol-ultra-fast", "gpt-5.6-sol", "ultra"],
    ["gpt-5.6-luna-ultra-fast", "gpt-5.6-luna", "max"],
    ["gpt-5.5-max-fast", "gpt-5.5", "xhigh"],
    ["gpt-5.6-sol-fast(high)", "gpt-5.6-sol", "high"],
    ["gpt-5.6-sol-review-max-fast", "gpt-5.6-sol", "max"],
  ])("%s → %s, effort %s, priority tier", (model, upstream, effort) => {
    const { body } = sendCodex(model);
    expect(body.model).toBe(upstream);
    expect(body.reasoning.effort).toBe(effort);
    expect(body.service_tier).toBe("priority");
  });

  it("keeps explicit body effort over the dash suffix, and forces priority over a body tier", () => {
    const { body } = sendCodex("gpt-5.6-sol-high-fast", { reasoning_effort: "low", service_tier: "flex" });
    expect(body.reasoning.effort).toBe("low");
    expect(body.service_tier).toBe("priority");
  });

  it("keeps GPT-6 Responses Lite shape and header for fast ids", () => {
    const { body, headers } = sendCodex("gpt-6-sol-max-fast");
    expect(body.model).toBe("gpt-6-sol");
    expect(body.reasoning).toEqual({ effort: "max", context: "all_turns" });
    expect(body.service_tier).toBe("priority");
    expect(headers["x-openai-internal-codex-responses-lite"]).toBe("true");
  });

  it("leaves non-fast ids on the existing convention", () => {
    const { body } = sendCodex("gpt-5.6-sol-high");
    expect(body.model).toBe("gpt-5.6-sol");
    expect(body.reasoning.effort).toBe("high");
    expect(body.service_tier).toBeUndefined();
  });

  it("shares base metadata and review quota family", () => {
    expect(getCapabilitiesForModel("codex", "gpt-5.6-sol-high-fast")).toEqual(getCapabilitiesForModel("codex", "gpt-5.6-sol"));
    expect(getThinkingLevels("codex", "gpt-5.6-sol-fast(high)")).toEqual(getThinkingLevels("codex", "gpt-5.6-sol"));
    expect(getModelQuotaFamily("cx", "gpt-5.6-sol-review-high-fast")).toBe("review");
    expect(getModelQuotaFamily("cx", "gpt-5.6-sol-high-fast")).toBe("normal");
  });

  it("does not apply to image models or other providers", () => {
    expect(getModelType("cx", "gpt-5.6-sol-image-fast")).toBeNull();
    expect(getModelUpstreamId("cx", "gpt-image-2-high-fast")).toBe("gpt-image-2-high-fast");
    expect(getModelUpstreamId("kr", "gpt-5.6-sol-high-fast")).toBe("gpt-5.6-sol-high-fast");
  });
});
