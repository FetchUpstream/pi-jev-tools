import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import jevTools, { GUIDELINE, TOOL_NAMES } from "../extensions/jev/index.ts";
import { NOT_CONFIGURED } from "../extensions/jev/lib/config.ts";
import { fixture, Q_JSON, response } from "./support.ts";
import { rm } from "node:fs/promises";

const keys = ["TYPESAFE_API_KEY", "OPENROUTER_API_KEY", "JEV_BACKEND"];
const saved = new Map<string, string | undefined>();
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
let dir: string;
let tools: ToolDefinition[];
beforeEach(async () => {
  for (const key of keys) { saved.set(key, process.env[key]); delete process.env[key]; }
  // Every fetch is offline, regardless of ambient credentials/JEV_LIVE.
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (_url, init) => {
    const body = JSON.parse(init!.body as string);
    return Response.json(response(body.questions));
  }) as typeof fetch);
  tools = [];
  jevTools({ registerTool: (tool: ToolDefinition) => { tools.push(tool); } } as ExtensionAPI);
  dir = await fixture();
});
afterEach(async () => {
  fetchSpy.mockRestore();
  for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  await rm(dir, { recursive: true, force: true });
});
function invoke(name: string, params: Record<string, unknown>) {
  const tool = tools.find((t) => t.name === name)!;
  expect(Check(tool.parameters, params)).toBe(true);
  return tool.execute("test", params, undefined, undefined, { cwd: dir } as ExtensionToolContext);
}

test("one entrypoint registers exactly six directly active tools with strict contracts", () => {
  expect(tools.map((t) => t.name)).toEqual([...TOOL_NAMES]);
  for (const tool of tools) {
    expect(tool.parameters).toHaveProperty("additionalProperties", false);
    expect(tool.description.length).toBeGreaterThan(20);
    expect(tool.outputSchema).toBeDefined();
    expect(tool.exposure ?? "direct").toBe("direct");
  }
  expect(tools[0].promptGuidelines).toEqual([GUIDELINE]);
});
test("package manifest points only to the registering entrypoint and declares host peers", async () => {
  const manifest = await Bun.file(new URL("../package.json", import.meta.url)).json();
  expect(manifest.pi.extensions).toEqual(["./extensions/jev/index.ts"]);
  expect(manifest.keywords).toContain("pi-package");
  expect(manifest.dependencies ?? {}).toEqual({});
  expect(manifest.peerDependencies).toEqual({ "@earendil-works/pi-coding-agent": "*", typebox: "*" });
});
test("missing credentials reach configuration boundary without any network calls", async () => {
  for (const [name, params] of [
    ["ask_jev_file_bool", { path: "src/a.ts", question: "Tokens?" }],
    ["ask_jev_files", { paths_or_globs: ["src/*.ts"], questions_json: Q_JSON }],
    ["ask_jev", { state: "tokens", questions_json: Q_JSON }],
  ] as const) await expect(invoke(name, params)).rejects.toThrow(NOT_CONFIGURED);
  expect(fetchSpy).not.toHaveBeenCalled();
});
test("all six tools execute with mocked network and match their output schemas", async () => {
  process.env.TYPESAFE_API_KEY = "unit-test-placeholder";
  const examples: Record<string, Record<string, unknown>> = {
    ask_jev: { paths: ["src/a.ts"], state: "customer reports invalid tokens", questions_json: Q_JSON },
    ask_jev_files: { paths_or_globs: ["src/*.ts"], questions_json: Q_JSON },
    pick_first_file: { question: "Where should I fix tokens?", candidates: [{ path: "src/a.ts" }] },
    ask_jev_file_bool: { path: "src/a.ts", question: "Does `content` validate tokens?" },
    ask_jev_file_choice: { path: "src/a.ts", question: "Which layer?", options: { auth: "Tokens" } },
    ask_jev_file_score: { path: "src/a.ts", question: "Risk?", levels: ["isolated", "sensitive"] },
  };
  for (const [name, params] of Object.entries(examples)) {
    const r = await invoke(name, params);
    expect(Check(tools.find((t) => t.name === name)!.outputSchema!, r.structuredContent)).toBe(true);
    expect(JSON.stringify(r.structuredContent)).toBe(JSON.stringify(r.details));
    expect(JSON.stringify(r)).not.toContain("export const");
    expect(r.usage?.totalTokens).toBeGreaterThan(0);
  }
  expect(fetchSpy).toHaveBeenCalledTimes(7); // 2 files; 1 each for the other 5 tools.
});
test("strict schemas reject extra fields, empty inputs and bad score scales", () => {
  const schema = (name: string) => tools.find((t) => t.name === name)!.parameters;
  expect(Check(schema("ask_jev"), { state: "x", questions_json: Q_JSON, extra: true })).toBe(false);
  expect(Check(schema("ask_jev"), { questions_json: " " })).toBe(false);
  expect(Check(schema("ask_jev"), { paths: [], questions_json: Q_JSON })).toBe(false);
  expect(Check(schema("ask_jev_file_score"), { path: "a", question: "risk", levels: ["only"] })).toBe(false);
  expect(Check(schema("ask_jev_file_choice"), { path: "a", question: "layer", options: {} })).toBe(false);
});
