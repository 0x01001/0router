import { describe, expect, it } from "vitest";

import { CursorExecutor } from "../../open-sse/executors/cursor.js";
import { encodeField, wrapConnectRPCFrame } from "../../open-sse/utils/cursorProtobuf.js";
import {
  normalizeCursorModelId,
  resolveCursorUpstreamModel,
  shouldPromoteThinkingToContent,
} from "../../open-sse/utils/cursorModel.js";
import { getModelInfoCore } from "../../open-sse/services/model.js";

const LEN = 2;

function cursorResponseFrame({ text = "", thinking = "" }) {
  const responseFields = [];
  if (text) responseFields.push(encodeField(1, LEN, text));
  if (thinking) {
    const thinkingMessage = encodeField(1, LEN, thinking);
    responseFields.push(encodeField(25, LEN, thinkingMessage));
  }
  const response = Buffer.concat(responseFields.map((field) => Buffer.from(field)));
  const envelope = encodeField(2, LEN, response);
  return Buffer.from(wrapConnectRPCFrame(envelope));
}

function parseSSE(text) {
  return text
    .split("\n\n")
    .filter((chunk) => chunk.startsWith("data: "))
    .map((chunk) => chunk.slice("data: ".length))
    .filter((data) => data !== "[DONE]")
    .map((data) => JSON.parse(data));
}

describe("Cursor default model compatibility", () => {
  it("normalizes legacy ids and resolves default/auto", () => {
    expect(normalizeCursorModelId("cu/claude-3-5-sonnet-20240620")).toBe("claude-4.5-sonnet");
    expect(resolveCursorUpstreamModel("cu/default")).toBe("claude-4.5-sonnet");
    expect(resolveCursorUpstreamModel("auto")).toBe("claude-4.5-sonnet");
    expect(shouldPromoteThinkingToContent("cu/default")).toBe(true);
    expect(shouldPromoteThinkingToContent("claude-4.5-sonnet-thinking")).toBe(true);
    expect(shouldPromoteThinkingToContent("gpt-5.3-codex")).toBe(false);
  });

  it("infers Cursor for bare default and auto aliases", async () => {
    await expect(getModelInfoCore("default", {})).resolves.toEqual({
      provider: "cursor",
      model: "default",
    });
    await expect(getModelInfoCore("auto", {})).resolves.toEqual({
      provider: "cursor",
      model: "auto",
    });
  });

  it("promotes visible text after </think> for non-streaming default", async () => {
    const executor = new CursorExecutor();
    const response = executor.transformProtobufToJSON(
      cursorResponseFrame({ thinking: "private reasoning</think>Hello!" }),
      "cu/default",
      { messages: [{ role: "user", content: "hi" }] },
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.choices[0].message.content).toBe("Hello!");
    expect(JSON.stringify(payload)).not.toContain("private reasoning");
  });

  it("promotes visible text after </think> for streaming default", async () => {
    const executor = new CursorExecutor();
    const buffer = Buffer.concat([
      cursorResponseFrame({ thinking: "private reasoning</think>Hel" }),
      cursorResponseFrame({ thinking: "lo!" }),
    ]);
    const response = executor.transformProtobufToSSE(
      buffer,
      "cu/default",
      { messages: [{ role: "user", content: "hi" }] },
    );
    const events = parseSSE(await response.text());
    const content = events.map((event) => event.choices?.[0]?.delta?.content || "").join("");

    expect(response.status).toBe(200);
    expect(content).toBe("Hello!");
    expect(JSON.stringify(events)).not.toContain("private reasoning");
  });

  it("returns 502 for a legacy empty completion", async () => {
    const executor = new CursorExecutor();
    const response = executor.transformProtobufToJSON(
      Buffer.alloc(0),
      "cu/default",
      { messages: [{ role: "user", content: "hi" }] },
    );
    const payload = await response.json();

    expect(response.status).toBe(502);
    expect(payload.error?.code).toBe("empty_completion");
  });
});
