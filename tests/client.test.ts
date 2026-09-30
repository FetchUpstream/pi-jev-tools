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

for (const status of [408, 429, 500, 501, 502, 503, 504, 529, 599]) {
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
for (const status of [400, 401, 402, 403, 404, 409, 422]) {
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
  const cyclic: { [key: string]: import("../extensions/jev/lib/types.ts").JsonContent } = {}; cyclic.self = cyclic;
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
  test("score wire ranges, level keys and field shapes are enforced", () => {
    for (const patch of [
      { score: -1 }, { score: 2 }, { score: NaN }, { score: "0.5" }, { score: undefined },
      { confidence: -1 }, { confidence: Infinity }, { legend: undefined },
      { legend: { "0": "isolated" } }, { legend: { "0": 42, "1": "sensitive" } },
      { probabilities: { "0": 1 } }, { probabilities: { "0": -0.1, "1": 1.1 } },
      { probabilities: { "0": 0, "1": 0 } }, { probabilities: { "0": 0.4, "1": 0.4 } },
    ]) {
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
  test("live jev-1.13.0 rounded score mismatches retain valid distributions", async () => {
    // Captured from public repository inputs; no request content or credentials retained.
    // Both failed the former 0.005 equality tolerance (independently rounded fields).
    const criteria = ["simple declarations or low-risk plumbing", "moderate validation or transformation logic", "complex IO, concurrency, security boundary, or likely bug"];
    const questions: Questions = { risk: { type: "score", instructions: "Rank review priority", criteria } };
    for (const [score, confidence, probabilities, weighted] of [
      [0.09, 0.87, { "0": 0.94, "1": 0.04, "2": 0.02 }, 0.08],
      [0.61, 0.22, { "0": 0.45, "1": 0.48, "2": 0.07 }, 0.62],
    ] as const) {
      const raw = { model: "jev-1.13.0", answers: { risk: { type: "score", score, confidence, probabilities, legend: Object.fromEntries(criteria.map((level, i) => [String(i), level])) } }, usage: { input_tokens: 20, output_tokens: 5 } };
      validateResponse(raw, questions);
      const result = await client(async () => Response.json(raw)).systemOne("x", questions);
      expect(result.answers.risk).toHaveProperty("score", weighted);
      expect(result.answers.risk).toHaveProperty("confidence", confidence);
      expect(result.answers.risk).toHaveProperty("probabilities", probabilities);
    }
  });
  test("canonical score stays within rubric bounds despite floating-point overshoot", async () => {
    const criteria = Array.from({ length: 10 }, (_, i) => `Level ${i}`);
    const questions: Questions = { risk: { type: "score", instructions: "Position?", criteria } };
    const probabilities = Object.fromEntries(criteria.map((_, i) => [String(i), i === 9 ? 0.992 : 0]));
    expect(9 * 0.992 / 0.992).toBeGreaterThan(9); // Deterministic reproduction.
    const raw = { model: "fixture", answers: { risk: { type: "score", score: 9, confidence: 1, probabilities, legend: Object.fromEntries(criteria.map((level, i) => [String(i), level])) } }, usage: { input_tokens: 1, output_tokens: 1 } };
    const result = await client(async () => Response.json(raw)).systemOne("x", questions);
    expect(result.answers.risk).toHaveProperty("score", 9);
  });
  test("scores and legends are canonicalized without mutating the provider response", async () => {
    const r = response(qs);
    r.answers.score = { type: "score", score: 0.35, confidence: 0.61, probabilities: { "0": 0.666, "1": 0.333 }, legend: { "0": "provider wording", "1": "sensitive" } };
    const snapshot = JSON.stringify(r);
    validateResponse(r, qs);
    const result = await client(async () => Response.json(r)).systemOne("x", qs);
    expect(result.answers.score).toEqual({ type: "score", score: 1 / 3, confidence: 0.61, probabilities: r.answers.score.probabilities, legend: { "0": "isolated", "1": "sensitive" } });
    expect(JSON.stringify(r)).toBe(snapshot);
    r.answers.score.score = 0;
    r.answers.score.probabilities = { "0": 0, "1": 1 };
    validateResponse(r, qs);
    expect(compactResponse(r, qs).answers.score).toHaveProperty("score", 1);
  });
});

test("SDK structured entries round-trip, including null and optional instructions", async () => {
  const questions: Questions = {
    n: { type: "noul", instructions: ["Is this relevant?", { exclusions: [false, 3, null] }], criteria: { true: { description: "Relevant", examples: [true] }, false: ["Unrelated"] } },
    c: { type: "choice", instructions: { question: "Which?", data: [1, true] }, criteria: { a: { description: "Related" }, other: ["No match"] } },
    s: { type: "score", instructions: null, criteria: [{ description: "Low", data: [1, false] }, ["High"]] },
    optional: { type: "noul", criteria: null },
  };
  const result = await client(async () => Response.json(response(questions))).systemOne("x", questions);
  expect(result.answers.s).toHaveProperty("legend", { "0": { description: "Low", data: [1, false] }, "1": ["High"] });
});

test("malformed nested content fails before network transport", async () => {
  const { validateRequest } = await import("../extensions/jev/lib/types.ts");
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  for (const bad of [undefined, NaN, Infinity, 1n, () => true, new Date(), cyclic]) {
    for (const q of [
      { type: "noul", instructions: { nested: bad } },
      { type: "noul", criteria: { true: { nested: bad } } },
      { type: "choice", criteria: { a: { nested: bad } } },
      { type: "score", criteria: ["Low", { nested: bad }] },
    ]) expect(() => validateRequest({ state: "x", questions: { q } })).toThrow();
  }
  for (const entry of [true, 42]) expect(() => validateRequest({ state: "x", questions: { q: { type: "noul", instructions: entry } } })).toThrow();
  expect(() => validateRequest({ state: null, questions: Q })).toThrow();
  expect(() => validateRequest({ state: "x", questions: { q: { type: "score", criteria: [null] } } })).toThrow();
});

test("structured legends validate both transport and Pi output shape", async () => {
  const { Check } = await import("typebox/value");
  const { GeneralOutput } = await import("../extensions/jev/lib/schemas.ts");
  const qs: Questions = { score: { type: "score", criteria: [{ description: "Low" }, ["High"]] } };
  const raw = response(qs);
  validateResponse(raw, qs);
  expect(Check(GeneralOutput, { ...compactResponse(raw, qs), state_summary: { own_fields: [], files: [], output: null, skipped: [], tokens: 0 } })).toBe(true);
  for (const invalid of [null, 42, true, { nested: undefined }, [Infinity]]) {
    const broken = { ...raw, answers: { score: { ...raw.answers.score, legend: { "0": invalid, "1": "High" } } } };
    expect(() => validateResponse(broken, qs)).toThrow(ContractError);
  }
});

test("aggregate and longest-question context budgets are independently enforced", async () => {
  let calls = 0;
  const c = client(async () => { calls++; return Response.json(response()); });
  const many: Questions = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [String(i), { type: "noul", instructions: "x".repeat(28_000) }]));
  await expect(c.systemOne("x", many)).rejects.toThrow("state + all questions");
  await expect(c.systemOne("x".repeat(100_000), { q: { type: "noul", instructions: "x".repeat(30_000) } })).rejects.toThrow("state + longest question");
  await expect(c.systemOne(String.fromCharCode(92).repeat(65_000), Q)).rejects.toThrow("state + longest question");
  expect(calls).toBe(0);
  await c.systemOne("x".repeat(90_000), { q: { type: "noul", instructions: "x".repeat(20_000) } });
  expect(calls).toBe(1);
});

test("model override precedence preserves moving latest defaults", async () => {
  expect(readConfig(env).model).toBe("jev-latest");
  expect(readConfig({ OPENROUTER_API_KEY: "placeholder" }).model).toBe("~typesafe/jev-latest");
  expect(readConfig({ ...env, TYPESAFE_DEFAULT_MODEL: "jev-1.13.0" }).model).toBe("jev-1.13.0");
  expect(readConfig({ ...env, JEV_MODEL: "jev-preview", TYPESAFE_DEFAULT_MODEL: "jev-1.13.0" }).model).toBe("jev-preview");
  expect(readConfig({ OPENROUTER_API_KEY: "placeholder", JEV_MODEL: "jev-1.13.0" }).model).toBe("~typesafe/jev-1.13.0");
  await new JevClient({ env: { ...env, JEV_MODEL: "jev-1.13.0" }, fetch: transport(async (_url, init) => {
    expect(JSON.parse(String(init.body)).model).toBe("jev-1.13.0"); return Response.json({ ...response(), model: "jev-1.13.0" });
  }) }).systemOne("x", Q);
});

test("retry timing uses millisecond precedence, dates and bounded server delays", async () => {
  const { parseRetryAfter, retryWaitMs, isRetryableStatus } = await import("../extensions/jev/lib/client.ts");
  expect(parseRetryAfter(new Headers({ "retry-after-ms": "12.5", "retry-after": "9" }))).toBe(12.5);
  expect(parseRetryAfter(new Headers({ "retry-after-ms": "bad", "retry-after": "0.75" }))).toBe(750);
  expect(parseRetryAfter(new Headers({ "retry-after": "Thu, 01 Jan 1970 00:00:02 GMT" }), 1000)).toBe(1000);
  for (const value of ["", "-1", "Infinity", "bad"]) expect(parseRetryAfter(new Headers({ "retry-after-ms": value }))).toBeUndefined();
  expect(retryWaitMs(1, 500, new Headers({ "retry-after-ms": "0" }), 0)).toBe(0);
  expect(retryWaitMs(1, 500, new Headers({ "retry-after": "61" }), 0)).toBe(500);
  expect(retryWaitMs(3, 500, undefined, 0)).toBe(2000);
  for (const status of [408, 429, 500, 504, 529, 599]) expect(isRetryableStatus(status)).toBe(true);
  for (const status of [400, 401, 409, 422, 600]) expect(isRetryableStatus(status)).toBe(false);
});

test("connection and timeout failures retry, without leaking transport messages", async () => {
  for (const error of [new TypeError("private"), new DOMException("private", "TimeoutError")]) {
    let calls = 0;
    await client(async () => { if (++calls < 3) throw error; return Response.json(response()); }).systemOne("x", Q);
    expect(calls).toBe(3);
  }
  let bodies = 0;
  await client(async () => ++bodies < 3 ? new Response(new ReadableStream({ start(controller) { controller.error(new Error("private")); } })) : Response.json(response())).systemOne("x", Q);
  expect(bodies).toBe(3);
});

test("cancellation and total deadline interrupt Retry-After waits", async () => {
  for (const cancel of [false, true]) {
    const controller = new AbortController();
    let calls = 0;
    const c = new JevClient({ env, timeoutMs: 20, fetch: transport(async () => {
      calls++;
      if (cancel) setTimeout(() => controller.abort(new Error("cancelled")), 2);
      return new Response("private", { status: 429, headers: { "retry-after": "60" } });
    }) });
    await expect(c.systemOne("x", Q, controller.signal)).rejects.toThrow(cancel ? "cancelled" : "timed out");
    expect(calls).toBe(1);
  }
});

test("distribution validation handles literal prototype-looking option names", () => {
  const qs: Questions = { q: { type: "choice", criteria: JSON.parse('{"__proto__":"literal option","other":null}') } };
  const raw: unknown = { model: "fixture", usage: { input_tokens: 1, output_tokens: 1 }, answers: { q: { type: "choice", choice: "__proto__", confidence: 1, probabilities: JSON.parse('{"__proto__":1,"other":0}') } } };
  expect(() => validateResponse(raw, qs)).not.toThrow();
});
