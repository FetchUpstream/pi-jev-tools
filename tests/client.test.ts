import { describe, expect, test } from "bun:test";
import { JevClient, retryAfterMs } from "../extensions/jev/lib/client.ts";
import { NOT_CONFIGURED, readConfig } from "../extensions/jev/lib/config.ts";
import { ContractError, compactResponse, validateResponse } from "../extensions/jev/lib/response.ts";
import type { Questions } from "../extensions/jev/lib/types.ts";
import { Q, response } from "./support.ts";

// All clients get an explicit environment and offline fetch stub. Never use ambient keys.
const env = { TYPESAFE_API_KEY: "unit-test-placeholder" };
function transport(fn: (url: string, init: RequestInit) => Promise<Response>): typeof fetch {
  return fn as typeof fetch;
}
function client(fn: (url: string, init: RequestInit) => Promise<Response>) {
  return new JevClient({ env, fetch: transport(fn), retryDelayMs: 0 });
}

describe("configuration", () => {
  test("TypeSafe first, OpenRouter second, blank keys ignored", () => {
    expect(readConfig({ ...env, OPENROUTER_API_KEY: "unit-test-placeholder" }).provider).toBe("typesafe");
    expect(readConfig({ TYPESAFE_API_KEY: " ", OPENROUTER_API_KEY: "unit-test-placeholder" }).provider).toBe("openrouter");
    expect(readConfig({ TYPESAFE_API_KEY: "  unit-test-placeholder  " }).apiKey).toBe("unit-test-placeholder");
  });
  test("explicit JEV_BACKEND wins, without fallback", () => {
    expect(readConfig({ ...env, OPENROUTER_API_KEY: "unit-test-placeholder", JEV_BACKEND: " openrouter " }).provider).toBe("openrouter");
    expect(() => readConfig({ ...env, JEV_BACKEND: "openrouter" })).toThrow("OPENROUTER_API_KEY");
    expect(() => readConfig({ ...env, JEV_BACKEND: "mock" })).toThrow("test-only");
    expect(() => readConfig({ JEV_BACKEND: "invalid" })).toThrow("JEV_BACKEND");
  });
  test("missing and blank credentials give an actionable error; no transport", async () => {
    for (const config of [{}, { TYPESAFE_API_KEY: " ", OPENROUTER_API_KEY: "" }]) {
      expect(() => readConfig(config)).toThrow(NOT_CONFIGURED);
      await expect(new JevClient({ env: config, fetch: transport(async () => { throw new Error("must not fetch"); }) }).systemOne("x", Q)).rejects.toThrow(NOT_CONFIGURED);
    }
  });
});

for (const provider of ["typesafe", "openrouter"] as const) {
  test(`${provider} wire endpoint, model, redirect policy and compact result`, async () => {
    let calls = 0;
    const c = new JevClient({ env: { JEV_BACKEND: provider, TYPESAFE_API_KEY: "unit-test-placeholder", OPENROUTER_API_KEY: "unit-test-placeholder" }, fetch: transport(async (url, init) => {
      calls++;
      expect(url).toBe(provider === "typesafe" ? "https://api.typesafe.ai/v1/systemone" : "https://openrouter.ai/api/alpha/decisions");
      expect(init.redirect).toBe("error");
      expect(init.method).toBe("POST");
      const body = JSON.parse(init.body as string);
      expect(body.model).toBe(provider === "typesafe" ? "jev-latest" : "~typesafe/jev-latest");
      expect(body.state).toEqual({ content: "tokens" });
      return Response.json({ ...response(), internal: "never expose", answers: { q: { type: "noul", noul: 0.8, prose: "never expose" } }, usage: { input_tokens: 20, output_tokens: 5, cost: 0, internal: "never expose" } });
    }) });
    const result = await c.systemOne({ content: "tokens" }, Q);
    expect(result).toEqual({ answers: { q: { type: "noul", noul: 0.8 } }, model: "jev-unit-test", usage: { input_tokens: 20, output_tokens: 5, cost: 0 } });
    expect(calls).toBe(1);
  });
}

for (const status of [429, 502, 503, 529]) {
  test(`retry ${status}, at most three attempts, same body`, async () => {
    const bodies: unknown[] = [];
    const result = await client(async (_url, init) => {
      bodies.push(init.body);
      return bodies.length < 3 ? new Response("retry", { status }) : Response.json(response());
    }).systemOne("x", Q);
    expect(result.answers.q).toEqual({ type: "noul", noul: 0.8 });
    expect(bodies.length).toBe(3);
    expect(new Set(bodies).size).toBe(1);
    let count = 0;
    await expect(client(async () => { count++; return new Response("retry", { status }); }).systemOne("x", Q)).rejects.toThrow(`HTTP ${status}`);
    expect(count).toBe(3);
  });
}
for (const status of [400, 401, 402, 403, 500]) {
  test(`HTTP ${status} does not retry or relay response text`, async () => {
    let count = 0;
    await expect(client(async () => { count++; return new Response("private-provider-payload", { status }); }).systemOne("x", Q)).rejects.toThrow(`HTTP ${status}`);
    expect(count).toBe(1);
  });
}
test("invalid JSON and network messages are sanitized", async () => {
  await expect(client(async () => new Response("not JSON")).systemOne("x", Q)).rejects.toBeInstanceOf(ContractError);
  await expect(client(async () => { throw new Error("private-transport-data"); }).systemOne("x", Q)).rejects.toThrow("Check network access");
});
test("abort before fetch; total timeout covers body", async () => {
  const c = client(async () => { throw new Error("must not fetch"); });
  await expect(c.systemOne("x", Q, AbortSignal.abort(new Error("stop")))).rejects.toThrow("stop");
  const stalled = new JevClient({ env, timeoutMs: 10, fetch: transport(async (_url, init) => new Response(new ReadableStream({
    start(controller) { init.signal!.addEventListener("abort", () => controller.error(init.signal!.reason), { once: true }); },
  }))) });
  await expect(stalled.systemOne("x", Q)).rejects.toThrow("timed out");
});
test("Retry-After handles invalid numbers and dates", () => {
  for (const header of [null, "garbage", "-1", "NaN", "Infinity"]) expect(retryAfterMs(header)).toBe(0);
  expect(retryAfterMs("0.75")).toBe(750);
  expect(retryAfterMs(new Date(Date.now() - 10_000).toUTCString())).toBe(0);
});
test("wire budget and malformed requests are refused before transport", async () => {
  const c = client(async () => { throw new Error("must not fetch"); });
  await expect(c.systemOne("x".repeat(256_000), Q)).rejects.toThrow("64k");
  await expect(c.systemOne("x", {})).rejects.toThrow("nonempty");
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  await expect(c.systemOne(cyclic, Q)).rejects.toThrow("JSON-serializable");
});

describe("response contracts", () => {
  test("boolean probability is finite and 0–1", () => {
    for (const noul of [-1, 1.1, NaN, "yes"]) expect(() => validateResponse({ ...response(), answers: { q: { type: "noul", noul } } }, Q)).toThrow(ContractError);
  });
  test("envelope, usage, missing/mismatched answers", () => {
    for (const invalid of [null, [], {}, { ...response(), model: " " }, { ...response(), usage: { input_tokens: -1, output_tokens: 2 } }, { ...response(), answers: {} }, { ...response(), answers: { q: { type: "choice" } } }]) expect(() => validateResponse(invalid, Q)).toThrow(ContractError);
  });
  const qs: Questions = { choice: { type: "choice", instructions: "Which?", criteria: { a: null, other: "none" } }, score: { type: "score", instructions: "Risk?", criteria: ["isolated", "sensitive"] } };
  test("valid choice and score retain numeric types", () => {
    const r = response(qs);
    expect(() => validateResponse(r, qs)).not.toThrow();
    expect(compactResponse(r, qs).answers).toEqual(r.answers);
  });
  test("choice must be declared; distribution keys and sum must match", () => {
    for (const patch of [{ choice: "unlisted" }, { confidence: 2 }, { probabilities: { a: 0.1, other: 0.1 } }, { probabilities: { a: 1, wrong: 0 } }]) {
      const r = response(qs); r.answers.choice = { ...r.answers.choice, ...patch } as typeof r.answers.choice;
      expect(() => validateResponse(r, qs)).toThrow(ContractError);
    }
  });
  test("score range, levels and legend are enforced", () => {
    for (const patch of [{ score: -1 }, { score: 2 }, { legend: { "0": "wrong", "1": "sensitive" } }, { probabilities: { "0": 1 } }]) {
      const r = response(qs); r.answers.score = { ...r.answers.score, ...patch } as typeof r.answers.score;
      expect(() => validateResponse(r, qs)).toThrow(ContractError);
    }
  });
  test("contradictory choices fail, including through the provider client; ties pass", async () => {
    const r = response(qs);
    r.answers.choice = { type: "choice", choice: "a", confidence: 1, probabilities: { a: 0, other: 1 } };
    expect(() => validateResponse(r, qs)).toThrow("maximum probability");
    await expect(client(async () => Response.json(r)).systemOne("x", qs)).rejects.toThrow("maximum probability");
    r.answers.choice.probabilities = { a: 0.5, other: 0.5 };
    expect(() => validateResponse(r, qs)).not.toThrow();
    r.answers.choice.choice = "other";
    expect(() => validateResponse(r, qs)).not.toThrow();
  });
  test("scores agree with normalized weighted probabilities, allowing two-decimal rounding", () => {
    const r = response(qs);
    r.answers.score = { type: "score", score: 0, confidence: 1, probabilities: { "0": 0, "1": 1 }, legend: { "0": "isolated", "1": "sensitive" } };
    expect(() => validateResponse(r, qs)).toThrow("probability-weighted");
    r.answers.score.probabilities = { "0": 0.666, "1": 0.333 };
    r.answers.score.score = 0.33;
    expect(() => validateResponse(r, qs)).not.toThrow();
    r.answers.score.score = 0.35;
    expect(() => validateResponse(r, qs)).toThrow("probability-weighted");
  });
});
