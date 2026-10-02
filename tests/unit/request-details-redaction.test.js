import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { SignJWT } from "jose";
import { NextRequest } from "next/server";

const SECRET_TEXT = vi.hoisted(() => {
  const secret = "request-details-test-secret";
  vi.stubEnv("JWT_SECRET", secret);
  return secret;
});

const mocks = vi.hoisted(() => ({
  getRequestDetails: vi.fn(),
  getSettings: vi.fn(),
}));

vi.mock("@/lib/usageDb", () => ({ getRequestDetails: mocks.getRequestDetails }));
vi.mock("@/lib/localDb", () => ({ getSettings: mocks.getSettings }));
// Keep dashboardSession from touching a real user data directory.
vi.mock("@/lib/dataDir", () => ({ DATA_DIR: "/nonexistent-test-data-dir" }));

const { createDashboardAuthToken } = await import("../../src/lib/auth/dashboardSession.js");
const { GET } = await import("../../src/app/api/usage/request-details/route.js");

const PAYLOAD_KEYS = ["request", "providerRequest", "providerResponse", "response"];
const SECRET = new TextEncoder().encode(SECRET_TEXT);

const makeResult = () => ({
  details: [{
    id: "abc",
    provider: "opencode",
    model: "deepseek-v4-flash-free",
    timestamp: "2026-08-05T00:00:00Z",
    status: "success",
    tokens: { prompt_tokens: 10, completion_tokens: 5 },
    latency: { total: 100 },
    request: { messages: [{ role: "user", content: "secret prompt" }] },
    providerRequest: { messages: [{ role: "user", content: "secret prompt" }] },
    providerResponse: { choices: [{ message: { content: "secret answer" } }] },
    response: { content: "secret answer" },
  }],
  pagination: { page: 1, pageSize: 20, totalItems: 1, totalPages: 1 },
});

const sign = (claims, { secret = SECRET, exp = "1h" } = {}) =>
  new SignJWT(claims).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime(exp).sign(secret);

const call = (token) =>
  GET(new NextRequest("http://localhost/api/usage/request-details", {
    headers: token ? { cookie: `auth_token=${token}` } : {},
  }));

let fixture;
let snapshot;

beforeEach(() => {
  vi.clearAllMocks();
  fixture = makeResult();
  snapshot = structuredClone(fixture);
  mocks.getRequestDetails.mockResolvedValue(fixture);
  mocks.getSettings.mockResolvedValue({ requireLogin: false });
});

afterAll(() => vi.unstubAllEnvs());

async function expectRedacted(response) {
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  const body = await response.json();
  const out = body.details[0];
  for (const key of PAYLOAD_KEYS) expect(out[key]).toEqual({ redacted: true });
  const { id, provider, model, timestamp, status, tokens, latency } = snapshot.details[0];
  expect(out).toMatchObject({ id, provider, model, timestamp, status, tokens, latency });
  expect(body.pagination).toEqual(snapshot.pagination);
  expect(JSON.stringify(body)).not.toContain("secret");
  expect(fixture).toEqual(snapshot);
}

describe("GET /api/usage/request-details payload visibility", () => {
  it("returns all four payload fields for a valid authenticated admin session", async () => {
    const response = await call(await createDashboardAuthToken());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual(snapshot);
    expect(fixture).toEqual(snapshot);
  });

  it("redacts when the cookie is missing, even with requireLogin=false", async () => {
    await expectRedacted(await call());
  });

  it("redacts a cookie signed with the wrong secret", async () => {
    const forged = await sign({ authenticated: true }, { secret: new TextEncoder().encode("attacker") });
    await expectRedacted(await call(forged));
  });

  it("redacts an unsigned (alg=none) token claiming authenticated", async () => {
    const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const unsigned = `${enc({ alg: "none", typ: "JWT" })}.${enc({ authenticated: true })}.`;
    await expectRedacted(await call(unsigned));
  });

  it("redacts an expired admin token", async () => {
    const expired = await sign({ authenticated: true }, { exp: Math.floor(Date.now() / 1000) - 60 });
    await expectRedacted(await call(expired));
  });

  it("redacts a validly signed session with authenticated:false", async () => {
    await expectRedacted(await call(await sign({ authenticated: false })));
  });
});
