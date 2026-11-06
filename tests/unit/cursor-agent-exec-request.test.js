import { describe, it, expect } from "vitest";
import zlib from "node:zlib";

import { CursorExecutor, parseConnectTrailerError } from "../../open-sse/executors/cursor.js";
import { encodeField, wrapConnectRPCFrame } from "../../open-sse/utils/cursorProtobuf.js";

const LEN = 2;

// agent.v1.AgentServerMessage.exec_request (field 2) carrying one ExecServerMessage variant.
function execRequestFrame(execField) {
  const execServerMessage = Buffer.from(encodeField(execField, LEN, new Uint8Array()));
  return Buffer.from(wrapConnectRPCFrame(encodeField(2, LEN, execServerMessage)));
}

// agent.v1.AgentServerMessage.interaction_update (field 1) → text delta.
function textFrame(text) {
  const textPart = Buffer.from(encodeField(1, LEN, text));
  const update = Buffer.from(encodeField(1, LEN, textPart));
  return Buffer.from(wrapConnectRPCFrame(encodeField(1, LEN, update)));
}

// InteractionUpdate.thinking_delta (field 4) + turn_ended (field 14).
function thinkingFrame(text) {
  const thinkingPart = Buffer.from(encodeField(1, LEN, text));
  const update = Buffer.from(encodeField(4, LEN, thinkingPart));
  return Buffer.from(wrapConnectRPCFrame(encodeField(1, LEN, update)));
}

function turnEndedFrame() {
  const update = Buffer.from(encodeField(14, LEN, new Uint8Array()));
  return Buffer.from(wrapConnectRPCFrame(encodeField(1, LEN, update)));
}

// InteractionUpdate field 13 with no payload: what AgentService emits right
// before an end-of-stream error trailer.
function emptyUpdateFrame() {
  const update = Buffer.from(encodeField(13, LEN, new Uint8Array()));
  return Buffer.from(wrapConnectRPCFrame(encodeField(1, LEN, update)));
}

// Connect end-of-stream trailer (flag 0x02, or 0x03 when gzip-compressed like
// the real agent.api5.cursor.sh response).
function trailerFrame(json, { gzip = false } = {}) {
  let payload = Buffer.from(JSON.stringify(json), "utf8");
  let flags = 0x02;
  if (gzip) {
    payload = zlib.gzipSync(payload);
    flags = 0x03;
  }
  const frame = Buffer.alloc(5 + payload.length);
  frame[0] = flags;
  frame.writeUInt32BE(payload.length, 1);
  payload.copy(frame, 5);
  return frame;
}

// Verbatim shape of Cursor's "buy credits" trailer (ERROR_USAGE_PRICING_REQUIRED).
const PRICING_TRAILER = {
  error: {
    code: "resource_exhausted",
    message: "Error",
    details: [{
      type: "aiserver.v1.ErrorDetails",
      debug: {
        error: "ERROR_USAGE_PRICING_REQUIRED",
        details: {
          title: "This model uses credits, not your weekly usage",
          detail: "Buy credits to keep going now.",
          isRetryable: false,
          showRequestId: false,
          additionalInfo: {
            rateLimitReason: "prepaid_balance_exhausted",
            prepaidWallet: "personal",
            unifiedSkuWeeklyLimit: "true",
            unifiedSkuLimitKind: "third_party_model",
            chatMessage: "*This model uses credits, not your weekly usage*",
          },
          buttons: [{ label: "Buy Credits", url: { url: "https://cursor.com/dashboard?tab=billing" } }],
          analyticsMetadata: { actionRequired: "payment" },
        },
        isExpected: true,
      },
      value: "CCwS7QIK",
    }],
  },
};

function stubAgentSession(executor, frames) {
  const written = [];
  const queue = [...frames];
  executor.openAgentHttp2Stream = () => ({
    responseHeaders: Promise.resolve({ ":status": 200 }),
    write: (frame) => written.push(Buffer.from(frame)),
    end() {},
    close() {},
    async read() {
      if (!queue.length) return { value: undefined, done: true };
      return { value: queue.shift(), done: false };
    },
  });
  return written;
}

const credentials = {
  accessToken: "test-token",
  providerSpecificData: { machineId: "a".repeat(64) },
};

function parseSSE(text) {
  return text
    .split("\n\n")
    .filter((chunk) => chunk.startsWith("data: "))
    .map((chunk) => chunk.slice("data: ".length))
    .filter((data) => data !== "[DONE]")
    .map((data) => JSON.parse(data));
}

async function runAgent({ frames, stream, model = "gpt-5.2", tools }) {
  const executor = new CursorExecutor();
  const written = stubAgentSession(executor, frames);
  const result = await executor.executeAgent({
    model,
    body: { messages: [{ role: "user", content: "hi" }], ...(tools ? { tools } : {}) },
    stream,
    credentials,
  });
  return { result, written };
}

describe("CursorExecutor AgentService exec_request handling", () => {
  it("acknowledges a request-context exec request without ending the turn", async () => {
    const { result, written } = await runAgent({
      frames: [execRequestFrame(10), textFrame("hello")],
      stream: true,
    });

    expect(written.length).toBe(2); // run frame + request-context reply
    const events = parseSSE(await result.response.text());
    const content = events.map((e) => e.choices?.[0]?.delta?.content || "").join("");
    expect(content).toBe("hello");
  });

  it("does not echo client tools on the request_context ack", async () => {
    const { written, result } = await runAgent({
      tools: [{ function: { name: "read_file", parameters: { type: "object" } } }],
      frames: [execRequestFrame(10), textFrame("hello")],
      stream: true,
    });

    expect(written.length).toBe(2);
    expect(written[1].toString("utf8")).not.toContain("read_file");
    const content = parseSSE(await result.response.text())
      .map((e) => e.choices?.[0]?.delta?.content || "")
      .join("");
    expect(content).toBe("hello");
  });

  it("does not render an unsupported exec request as assistant content", async () => {
    const { result, written } = await runAgent({
      frames: [textFrame("partial answer"), execRequestFrame(2), textFrame(" more")],
      stream: true,
    });

    const body = await result.response.text();
    expect(body).not.toContain("unsupported IDE tool");
    const events = parseSSE(body);
    const content = events.map((e) => e.choices?.[0]?.delta?.content || "").join("");
    expect(content).toBe("partial answer more");
    expect(events.some((e) => e.error)).toBe(false);
    expect(written.length).toBe(2); // run frame + IDE rejection
  });

  it("still emits later text after rejecting an IDE exec in the same read", async () => {
    const { result } = await runAgent({
      frames: [Buffer.concat([execRequestFrame(2), textFrame("late")])],
      stream: true,
    });

    const body = await result.response.text();
    expect(body).not.toContain("unsupported IDE tool");
    expect(body).toContain("late");
  });

  it("returns a non-200 error body for an unsupported exec request when not streaming", async () => {
    const { result } = await runAgent({
      frames: [execRequestFrame(11)],
      stream: false,
    });

    expect(result.response.status).not.toBe(200);
    const payload = await result.response.json();
    expect(payload.error.message).toContain("unsupported IDE tool");
  });

  it("streams Composer visible content from thinking_delta after </think>", async () => {
    const { result } = await runAgent({
      model: "composer-2.5",
      frames: [
        thinkingFrame("private reasoning that must not leak</think>OK"),
        turnEndedFrame(),
      ],
      stream: true,
    });

    const events = parseSSE(await result.response.text());
    const content = events.map((e) => e.choices?.[0]?.delta?.content || "").join("");
    expect(content).toBe("OK");
    expect(JSON.stringify(events)).not.toContain("private reasoning");
  });

  it("flushes Grok thinking as visible content when the turn has no text_delta", async () => {
    const { result } = await runAgent({
      model: "grok-4.5",
      frames: [thinkingFrame("hello from grok"), turnEndedFrame()],
      stream: true,
    });

    const events = parseSSE(await result.response.text());
    const content = events.map((e) => e.choices?.[0]?.delta?.content || "").join("");
    expect(content).toBe("hello from grok");
  });
});

describe("parseConnectTrailerError", () => {
  it("maps Cursor ERROR_USAGE_PRICING_REQUIRED to 402 with the upstream message", () => {
    const parsed = parseConnectTrailerError(Buffer.from(JSON.stringify(PRICING_TRAILER)));
    expect(parsed.status).toBe(402);
    expect(parsed.code).toBe("resource_exhausted");
    expect(parsed.upstreamCode).toBe("ERROR_USAGE_PRICING_REQUIRED");
    expect(parsed.message).toContain("ERROR_USAGE_PRICING_REQUIRED");
    expect(parsed.message).toContain("This model uses credits, not your weekly usage");
    expect(parsed.message).toContain("Buy credits to keep going now");
    expect(parsed.message).toContain("https://cursor.com/dashboard?tab=billing");
  });

  it("maps plain resource_exhausted to 429 and unauthenticated to 401", () => {
    expect(parseConnectTrailerError(Buffer.from(JSON.stringify({
      error: { code: "resource_exhausted", message: "too many requests" },
    })))).toMatchObject({ status: 429, message: "Cursor too many requests" });
    expect(parseConnectTrailerError(Buffer.from(JSON.stringify({
      error: { code: "unauthenticated", message: "token expired" },
    })))).toMatchObject({ status: 401 });
    expect(parseConnectTrailerError(Buffer.from(JSON.stringify({
      error: { code: "permission_denied", message: "nope" },
    })))).toMatchObject({ status: 403 });
  });

  it("returns null for a trailer without an error and for non-JSON payloads", () => {
    expect(parseConnectTrailerError(Buffer.from("{}"))).toBeNull();
    expect(parseConnectTrailerError(Buffer.from(JSON.stringify({ metadata: {} })))).toBeNull();
    expect(parseConnectTrailerError(Buffer.from("not json"))).toBeNull();
    expect(parseConnectTrailerError(new Uint8Array())).toBeNull();
  });
});

describe("CursorExecutor AgentService Connect trailer errors", () => {
  it("returns 402 instead of an empty completion when credits are exhausted (non-stream)", async () => {
    const { result } = await runAgent({
      model: "claude-4.6-sonnet-high-thinking",
      frames: [emptyUpdateFrame(), trailerFrame(PRICING_TRAILER, { gzip: true })],
      stream: false,
    });

    expect(result.response.status).toBe(402);
    expect(result.response.headers.get("Content-Type")).toContain("application/json");
    const payload = await result.response.json();
    expect(payload.error.type).toBe("billing_error");
    expect(payload.error.code).toBe("payment_required");
    expect(payload.error.message).toContain("ERROR_USAGE_PRICING_REQUIRED");
    expect(payload.error.message).toContain("Buy credits to keep going now");
    expect(payload.choices).toBeUndefined();
  });

  it("returns 402 JSON instead of an empty SSE body when the trailer error precedes any content (stream)", async () => {
    const { result } = await runAgent({
      model: "claude-4.6-sonnet-high-thinking",
      frames: [emptyUpdateFrame(), trailerFrame(PRICING_TRAILER, { gzip: true })],
      stream: true,
    });

    expect(result.response.status).toBe(402);
    expect(result.response.headers.get("Content-Type")).toContain("application/json");
    const payload = await result.response.json();
    expect(payload.error.type).toBe("billing_error");
    expect(payload.error.message).toContain("ERROR_USAGE_PRICING_REQUIRED");
  });

  it("returns 429 for a plain resource_exhausted trailer and 401 for unauthenticated", async () => {
    const rateLimited = await runAgent({
      frames: [trailerFrame({ error: { code: "resource_exhausted", message: "rate limit" } })],
      stream: false,
    });
    expect(rateLimited.result.response.status).toBe(429);
    expect((await rateLimited.result.response.json()).error.type).toBe("rate_limit_error");

    const unauthenticated = await runAgent({
      frames: [trailerFrame({ error: { code: "unauthenticated", message: "token expired" } })],
      stream: true,
    });
    expect(unauthenticated.result.response.status).toBe(401);
    expect((await unauthenticated.result.response.json()).error.message).toContain("token expired");
  });

  it("handles a trailer that arrives in the same read as the preceding frame", async () => {
    const { result } = await runAgent({
      frames: [Buffer.concat([emptyUpdateFrame(), trailerFrame(PRICING_TRAILER)])],
      stream: false,
    });
    expect(result.response.status).toBe(402);
  });

  it("emits an SSE error frame when the trailer error arrives after content was already streamed", async () => {
    const { result } = await runAgent({
      frames: [textFrame("partial"), trailerFrame({ error: { code: "internal", message: "backend crashed" } })],
      stream: true,
    });

    expect(result.response.status).toBe(200);
    const body = await result.response.text();
    const events = parseSSE(body);
    const content = events.map((e) => e.choices?.[0]?.delta?.content || "").join("");
    expect(content).toBe("partial");
    const errorEvent = events.find((e) => e.error);
    expect(errorEvent.error.message).toContain("backend crashed");
    expect(errorEvent.error.type).toBe("server_error");
    expect(body.trim().endsWith("data: [DONE]")).toBe(true);
  });

  it("ignores a success trailer and a trailer after turn_ended", async () => {
    const ok = await runAgent({
      frames: [textFrame("hello"), turnEndedFrame(), trailerFrame({})],
      stream: true,
    });
    const events = parseSSE(await ok.result.response.text());
    expect(events.some((e) => e.error)).toBe(false);
    expect(events.map((e) => e.choices?.[0]?.delta?.content || "").join("")).toBe("hello");

    const late = await runAgent({
      frames: [textFrame("done"), turnEndedFrame(), trailerFrame(PRICING_TRAILER)],
      stream: false,
    });
    expect(late.result.response.status).toBe(200);
    const payload = await late.result.response.json();
    expect(payload.choices[0].message.content).toBe("done");
  });
});
