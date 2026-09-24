import { describe, it, expect } from "vitest";

import { CursorExecutor } from "../../open-sse/executors/cursor.js";
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

function trailerFrame(payload) {
  const frame = Buffer.from(wrapConnectRPCFrame(Buffer.from(JSON.stringify(payload))));
  frame[0] = 0x02;
  return frame;
}

const authTrailer = {
  error: {
    code: "unauthenticated",
    message: "Error",
    details: [{
      debug: {
        error: "ERROR_NOT_LOGGED_IN",
        details: { title: "Authentication error" },
      },
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

async function runAgent({ frames, stream }) {
  const executor = new CursorExecutor();
  const written = stubAgentSession(executor, frames);
  const result = await executor.executeAgent({
    model: "gpt-5.2",
    body: { messages: [{ role: "user", content: "hi" }] },
    stream,
    credentials,
  });
  return { result, written };
}

describe("CursorExecutor AgentService exec_request handling", () => {
  it("returns 502 for an empty non-streaming completion", async () => {
    const { result } = await runAgent({ frames: [], stream: false });

    expect(result.response.status).toBe(502);
    const payload = await result.response.json();
    expect(payload.error?.code).toBe("empty_completion");
  });

  it("emits an SSE error instead of a successful stop for an empty stream", async () => {
    const { result } = await runAgent({ frames: [], stream: true });

    const events = parseSSE(await result.response.text());
    expect(events.find((event) => event.error)?.error?.code).toBe("empty_completion");
    expect(events.some((event) => event.choices?.[0]?.finish_reason === "stop")).toBe(false);
  });

  it("surfaces a Connect authentication trailer in a stream", async () => {
    const { result } = await runAgent({ frames: [trailerFrame(authTrailer)], stream: true });
    const events = parseSSE(await result.response.text());
    const error = events.find((event) => event.error)?.error;

    expect(error).toEqual({
      message: "Authentication error",
      type: "authentication_error",
      code: "ERROR_NOT_LOGGED_IN",
    });
    expect(error?.code).not.toBe("empty_completion");
    expect(events.some((event) => event.choices?.[0]?.finish_reason === "stop")).toBe(false);
  });

  it("surfaces a Connect authentication trailer when not streaming", async () => {
    const { result } = await runAgent({ frames: [trailerFrame(authTrailer)], stream: false });
    const payload = await result.response.json();

    expect(result.response.status).toBe(401);
    expect(payload.error).toEqual({
      message: "Authentication error",
      type: "authentication_error",
      code: "ERROR_NOT_LOGGED_IN",
    });
  });

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

  it("stubs an unsupported exec request and keeps prior assistant content", async () => {
    const { result, written } = await runAgent({
      frames: [textFrame("partial answer"), execRequestFrame(2)],
      stream: true,
    });

    expect(written.length).toBeGreaterThanOrEqual(2); // run frame + exec stub reply
    const body = await result.response.text();
    expect(body).not.toContain("unsupported IDE tool");
    const events = parseSSE(body);
    const content = events.map((e) => e.choices?.[0]?.delta?.content || "").join("");
    expect(content).toBe("partial answer");
    expect(events.find((e) => e.error)).toBeUndefined();
  });

  it("continues after an exec stub even when batched in the same read", async () => {
    const { result, written } = await runAgent({
      frames: [Buffer.concat([execRequestFrame(2), textFrame("late")])],
      stream: true,
    });

    expect(written.length).toBeGreaterThanOrEqual(2);
    const body = await result.response.text();
    expect(body).not.toContain("unsupported IDE tool");
    const events = parseSSE(body);
    const content = events.map((e) => e.choices?.[0]?.delta?.content || "").join("");
    expect(content).toBe("late");
  });

  it("returns empty completion when an exec stub ends a non-streaming turn", async () => {
    const { result } = await runAgent({
      frames: [execRequestFrame(11)],
      stream: false,
    });

    expect(result.response.status).toBe(502);
    const payload = await result.response.json();
    expect(payload.error?.code).toBe("empty_completion");
  });
});
