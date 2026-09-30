import { afterEach, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assembleState, suggestSplit } from "../extensions/jev/lib/assemble.ts";
import type { Decide } from "../extensions/jev/lib/client.ts";
import { parseQuestions, parseState } from "../extensions/jev/lib/questions.ts";
import { askFileBool, askFileChoice, askFileScore } from "../extensions/jev/tools/ask-jev-file.ts";
import { askFiles } from "../extensions/jev/tools/ask-jev-files.ts";
import { pickFirstFile } from "../extensions/jev/tools/pick-first-file.ts";
import { askJev } from "../extensions/jev/tools/ask-jev.ts";
import { fakeDecide, fixture, Q_JSON } from "./support.ts";
const dirs: string[] = [];
async function make(files?: Record<string, string | Buffer>) { const dir = await fixture(files); dirs.push(dir); return dir; }
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

test("boolean reads content internally; >0.5 is true, exactly 0.5 is false", async () => {
  const dir = await make();
  const decide: Decide = async (state, questions) => {
    expect(state).toEqual({ path: "src/a.ts", content: "export const checkToken = true;" });
    expect(questions.answer).toMatchObject({ criteria: { true: "checks tokens", false: "does not" } });
    return fakeDecide(state, questions);
  };
  const r = await askFileBool("src/a.ts", "Does `content` validate tokens?", dir, { yes: "checks tokens", no: "does not" }, decide);
  expect(r.answer).toBe(true);
  expect(JSON.stringify(r)).not.toContain("export const");
  const tie: Decide = async () => ({ answers: { answer: { type: "noul", noul: 0.5 } }, model: "test", usage: { input_tokens: 1, output_tokens: 1 } });
  expect((await askFileBool("src/a.ts", "Tokens?", dir, {}, tie)).answer).toBe(false);
});
test("choice adds an exit and validates the resulting option cap before reading", async () => {
  const dir = await make();
  const decide: Decide = async (state, questions) => {
    expect(questions.answer).toMatchObject({ criteria: { handler: "Routes", other: "None of the above" } });
    return fakeDecide(state, questions);
  };
  expect((await askFileChoice("src/a.ts", "Which layer?", { handler: "Routes" }, dir, decide)).choice).toBe("handler");
  const tooMany = Object.fromEntries(Array.from({ length: 255 }, (_, i) => [`option${i}`, "situation"]));
  await expect(askFileChoice("missing.ts", "Which?", tooMany, dir, fakeDecide)).rejects.toThrow("maximum is 255");
});
test("score returns weighted position and nearest level description", async () => {
  const dir = await make();
  const r = await askFileScore("src/a.ts", "How risky?", ["isolated", "security sensitive"], dir, fakeDecide);
  expect(r).toMatchObject({ score: 1, top: 1, nearest: "security sensitive", confidence: 0.9 });
  await expect(askFileScore("src/a.ts", "Risk?", ["only one"], dir, fakeDecide)).rejects.toThrow("between 2 and 10");
});
test("multiple-file partial failure retains useful results and successful/attempted counts", async () => {
  const dir = await make({ "a.ts": "a", "b.ts": "b", "binary.dat": Buffer.from([0]), "missing-empty.ts": "" });
  const decide: Decide = async (state, questions) => {
    if (typeof state === "object" && "path" in state && state.path === "b.ts") throw new Error("provider HTTP 503");
    return fakeDecide(state, questions);
  };
  const r = await askFiles(["**/*"], Q_JSON, dir, decide);
  expect(r.results.map((r) => r.path)).toEqual(["a.ts"]);
  expect(r.calls).toBe(1);
  expect(r.attempts).toBe(2);
  expect(r.skipped.some((r) => r.path === "b.ts" && r.reason.includes("503"))).toBe(true);
  expect(r.skipped.some((r) => r.reason.includes("binary"))).toBe(true);
});
test("empty patterns never call provider; cancellation propagates", async () => {
  const dir = await make();
  const never: Decide = async () => { throw new Error("must not call"); };
  const r = await askFiles(["absent*.ts"], Q_JSON, dir, never);
  expect(r.calls).toBe(0);
  expect(r.skipped[0].reason).toContain("no files matched");
  await expect(askFiles(["src/*.ts"], Q_JSON, dir, never, false, AbortSignal.abort(new Error("cancel")))).rejects.toThrow("cancel");
});
test("batch caps at 255 files and bounds requests to 16", async () => {
  const dir = await make(Object.fromEntries(Array.from({ length: 260 }, (_, i) => [`f${i}.ts`, "x"])));
  let active = 0, peak = 0;
  const decide: Decide = async (s, q) => {
    active++; peak = Math.max(peak, active); await Bun.sleep(1); active--; return fakeDecide(s, q);
  };
  const r = await askFiles(["*.ts"], Q_JSON, dir, decide);
  expect(r.calls).toBe(255);
  expect(r.skipped.filter((s) => s.reason.includes("file cap")).length).toBe(5);
  expect(peak).toBeLessThanOrEqual(16);
  expect(peak).toBeGreaterThan(1);
});
test("pick returns declared path; none, weak, empty and reserved candidate handling", async () => {
  const candidates = [{ path: "src/a.ts", note: "auth" }, { path: "src/b.ts" }];
  expect((await pickFirstFile("Where first?", candidates, fakeDecide)).path).toBe("src/a.ts");
  expect((await pickFirstFile("Where?", [], fakeDecide)).path).toBeNull();
  const weak: Decide = async () => ({ model: "test", usage: { input_tokens: 1, output_tokens: 1 }, answers: { pick: { type: "choice", choice: "src/a.ts", confidence: 0.2, probabilities: { "src/a.ts": 0.2, none: 0.8 } } } });
  expect((await pickFirstFile("Where?", candidates, weak)).path).toBeNull();
  const none: Decide = async (s, q) => { const r = await weak(s, q); if (r.answers.pick.type === "choice") { r.answers.pick.choice = "none"; r.answers.pick.confidence = 0.8; } return r; };
  expect((await pickFirstFile("Where?", candidates, none)).path).toBeNull();
  await expect(pickFirstFile("Where?", [{ path: "none" }], fakeDecide)).rejects.toThrow("reserved");
});
test("question JSON rejects malformed, wrong types, unknown fields and invalid rubrics", () => {
  for (const json of ["{bad", "[]", "{}", '{"q":{"type":"chat","instructions":"x"}}', '{"q":{"type":"noul","instructions":" "}}', '{"q":{"type":"score","instructions":"x","criteria":["only"]}}', '{"q":{"type":"choice","instructions":"x","criteria":{}}}', '{"q":{"type":"noul","instructions":"x","extra":1}}']) expect(() => parseQuestions(json)).toThrow();
  expect(parseQuestions(Q_JSON)).toHaveProperty("q");
});
test("state parsing and assembly preserve field names, files and command output", async () => {
  expect(parseState('{"report":"failure"}')).toEqual({ report: "failure" });
  expect(parseState("[1,2]")).toEqual([1, 2]);
  expect(parseState("{bad}")).toBe("{bad}");
  const dir = await make();
  const assembled = await assembleState({ state: '{"report":"failure"}', paths: ["src/a.ts"], command: "git diff" }, dir, async (command) => ({ command, exit_code: 1, stdout: "failure", stderr: "" }));
  expect(assembled.state).toMatchObject({ report: "failure", files: { "src/a.ts": "export const checkToken = true;" }, output: { exit_code: 1 } });
  expect(assembled.summary.own_fields).toEqual(["report"]);
  expect(assembled.summary.files).toEqual(["src/a.ts"]);
});
test("ask_jev returns only judgments and a small summary", async () => {
  const dir = await make();
  const r = await askJev({ state: "Customer reports invalid tokens", paths: ["src/a.ts"], questions_json: Q_JSON }, dir, fakeDecide);
  expect(r.answers.q).toMatchObject({ type: "noul", noul: 0.8 });
  expect(r.state_summary.files).toEqual(["src/a.ts"]);
  expect(JSON.stringify(r)).not.toContain("export const");
  await expect(askJev({ questions_json: Q_JSON }, dir, fakeDecide)).rejects.toThrow("nothing to judge");
  await expect(askJev({ state: " ", questions_json: Q_JSON }, dir, fakeDecide)).rejects.toThrow("nothing to judge");
  await expect(askJev({ state: "x".repeat(9000), questions_json: Q_JSON }, dir, fakeDecide)).rejects.toThrow("Do not paste");
  await expect(askJev({ paths: ["absent*.ts"], questions_json: Q_JSON }, dir, fakeDecide)).rejects.toThrow("no files matched");
});
test("ask_jev file cap, token overflow and split guidance are retained", async () => {
  const dir = await make(Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`f${i}.ts`, "x"])));
  await expect(askJev({ paths: ["*.ts"], questions_json: Q_JSON }, dir, fakeDecide)).rejects.toThrow("more than 20 files");
  await writeFile(join(dir, "big1.txt"), "x".repeat(150_000));
  await writeFile(join(dir, "big2.txt"), "x".repeat(150_000));
  await expect(askJev({ paths: ["big*.txt"], questions_json: Q_JSON }, dir, fakeDecide)).rejects.toThrow("Split into 2 calls");
  const groups = suggestSplit([{ name: "a", tokens: 30, kind: "file" }, { name: "b", tokens: 25, kind: "file" }, { name: "c", tokens: 20, kind: "file" }], 50);
  expect(groups.map((g) => g.map((p) => p.name))).toEqual([["a", "c"], ["b"]]);
});

test("batch and general discovery keep bracketed files and canonicalize aliases", async () => {
  const dir = await make({ "[id].ts": "route", "a.ts": "source" });
  const paths = ["*.ts", "[id].ts", "a.ts", "./a.ts", join(dir, "a.ts")];
  let calls = 0;
  const decide: Decide = async (s, q) => { calls++; return fakeDecide(s, q); };
  const batch = await askFiles(paths, Q_JSON, dir, decide);
  expect(batch.results.map((r) => r.path).sort()).toEqual(["[id].ts", "a.ts"]);
  expect(batch.skipped).toEqual([]);
  expect(calls).toBe(2);
  const general = await askJev({ paths, questions_json: Q_JSON }, dir, decide);
  expect(general.state_summary.files.sort()).toEqual(["[id].ts", "a.ts"]);
  expect(calls).toBe(3);
});

test("rejected NUL binaries do not consume batch or general file slots", async () => {
  const files: Record<string, string | Buffer> = Object.fromEntries(Array.from({ length: 255 }, (_, i) => [`a${i}.dat`, Buffer.from([1, 0, 2])]));
  files["z.txt"] = "valid text";
  const dir = await make(files);
  const batch = await askFiles(["*"], Q_JSON, dir, fakeDecide);
  expect(batch.calls).toBe(1);
  expect(batch.results[0].path).toBe("z.txt");
  expect(batch.skipped.length).toBe(255);
  expect(batch.skipped.every((s) => s.reason.includes("binary"))).toBe(true);
  const general = await askJev({ paths: ["*"], questions_json: Q_JSON }, dir, fakeDecide);
  expect(general.state_summary.files).toEqual(["z.txt"]);
});
