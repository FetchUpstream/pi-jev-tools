// Real installed Pi CLI + real interactive renderer, with deterministic loopback
// PRIMARY and Jev transports. No credentials or paid calls required.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";

const repository = fileURLToPath(new URL("../", import.meta.url));
const root = await mkdtemp(join(tmpdir(), "pi-jev-ui-"));
const agentDir = join(root, "agent");
const cwd = join(root, "project");
const preload = join(root, "fixture.mjs");
const questions_json = JSON.stringify({ relevant: { type: "noul", instructions: "Worth inspecting?" }, category: { type: "choice", instructions: "Which subsystem?", criteria: { security: "Security boundary", other: "Other" } } });
const calls = [
  { name: "ask_jev_file_bool", arguments: { path: "src/a.ts", question: "Does this validate tokens?" } },
  { name: "ask_jev_file_choice", arguments: { path: "src/a.ts", question: "Which category fits?", options: { security: "Security boundary" } } },
  { name: "ask_jev_file_score", arguments: { path: "src/a.ts", question: "Where on the ordered scale?", levels: ["Simple", "Moderate", "Complex / likely bug"] } },
  { name: "pick_first_file", arguments: { question: "Which file first?", candidates: [{ path: "src/a.ts" }] } },
  { name: "ask_jev", arguments: { paths: ["src/a.ts"], state: "Review context", questions_json } },
  { name: "ask_jev_files", arguments: { paths_or_globs: ["src/*.ts"], questions_json } },
  { name: "ask_jev_file_bool", arguments: { path: "missing.ts", question: "Could this be relevant?" } },
  { name: "ask_jev_files", arguments: { paths_or_globs: ["src/fault.ts"], questions_json } },
];
const fixture = `
let delegate = globalThis.fetch;
async function fixtureFetch(input, init) {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url !== "https://api.typesafe.ai/v1/systemone") return delegate(input, init);
  const {state, questions} = JSON.parse(init.body);
  if (state.path === "src/fault.ts") return new Response("not relayed", {status: 500});
  const answers = Object.fromEntries(Object.entries(questions).map(([id, q]) => {
    if (q.type === "noul") return [id, {type: "noul", noul: 0.24}];
    const keys = q.type === "choice" ? Object.keys(q.criteria) : q.criteria.map((_,i) => String(i));
    if (q.type === "choice") return [id, {type: "choice", choice: keys[0], confidence: 0.54, probabilities: Object.fromEntries(keys.map((key,i) => [key, i === 0 ? 1 : 0]))}];
    return [id, {type: "score", score: 1.95, confidence: 0.9, probabilities: {"0": 0, "1": 0.06, "2": 0.94}, legend: {"0": "provider wording", "1": "provider wording", "2": "provider wording"}}];
  }));
  return Response.json({model: "jev-ui-fixture", answers, usage: {input_tokens: 20, output_tokens: 5, cost: 0.0001}});
}
Object.defineProperty(globalThis, "fetch", {configurable: true, get: () => fixtureFetch, set: (value) => {if (value !== fixtureFetch) delegate = value;}});
`;
const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1", TYPESAFE_API_KEY: "fixture-only", OPENROUTER_API_KEY: "", JEV_BACKEND: "typesafe", PI_JEV_UI_KEY: "loopback-only", NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` };
let verifiedResponses = 0;
let serverError: unknown;
const server = createServer(async (req, res) => {
  try {
    let text = "";
    for await (const chunk of req) text += chunk;
    const payload = JSON.parse(text);
    const results = payload.messages.filter((message: { role: string }) => message.role === "tool");
    const first = results.length === 0;
    if (!first) {
      assert.equal(results.length, calls.length);
      for (let i = 0; i < calls.length; i++) {
        const message = results.find((result: { tool_call_id: string }) => result.tool_call_id === `ui_${i}`);
        assert(message, `Missing model-facing tool result ${i}`);
        if (i === 6) { assert(message.content.includes("not found")); continue; }
        const result = JSON.parse(message.content);
        if (i === 0) { assert.equal(result.noul, 0.24); assert(result.usage.input_tokens > 0); }
        if (i === 1) assert(result.probabilities.security === 1);
        if (i === 2) { assert.equal(result.score, 1.94); assert.equal(result.legend["2"], "Complex / likely bug"); }
        if (i === 3) assert(result.probabilities["src/a.ts"] === 1);
        if (i === 4) { assert(result.answers.category.probabilities); assert(result.state_summary.files); assert(result.model); }
        if (i === 5) { assert.equal(result.calls, 7); assert.equal(result.attempts, 8); assert.equal(result.skipped.length, 1); }
        if (i === 7) { assert.equal(result.calls, 0); assert.equal(result.attempts, 1); assert(result.skipped[0].reason.includes("HTTP 500")); }
      }
      verifiedResponses++;
    }
    const delta = first ? { role: "assistant", tool_calls: calls.map((call, index) => ({ index, id: `ui_${index}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) } : { role: "assistant", content: "UI verification completed." };
    const chunk = (delta: unknown, finish_reason: string | null) => ({ id: "ui", object: "chat.completion.chunk", created: 1, model: "scripted", choices: [{ index: 0, delta, finish_reason }] });
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(`data: ${JSON.stringify(chunk(delta, null))}\n\ndata: ${JSON.stringify(chunk({}, first ? "tool_calls" : "stop"))}\n\ndata: [DONE]\n\n`);
  } catch (error) { serverError = error; res.writeHead(500); res.end("Verification failed"); }
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert(address && typeof address !== "string");

async function command(program: string, args: string[], interactive = false) {
  const child = spawn(program, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  if (!interactive) child.stdin.end();
  let stdout = "", stderr = "", closing = false;
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    if (interactive && !closing && stripVTControlCharacters(stdout).includes("UI verification completed.")) {
      closing = true;
      // Pi's actual expand-tools shortcut, then exit from the idle editor.
      setTimeout(() => child.stdin.write("\x0f"), 400);
      setTimeout(() => child.stdin.write("\x04"), 1000);
    }
  });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 90_000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
    if (serverError) throw serverError;
    assert.equal(code, 0, `${program} ${args.join(" ")} failed: ${stderr}\n${stdout.slice(-2000)}`);
    return { stdout, stderr };
  } finally { clearTimeout(timer); }
}
try {
  await mkdir(join(cwd, "src"), { recursive: true }); await mkdir(agentDir, { recursive: true });
  await writeFile(preload, fixture);
  for (const name of ["a", "b", "c", "d", "e", "f", "g", "fault"]) await writeFile(join(cwd, "src", `${name}.ts`), "export const tokens = true;\n");
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ theme: "dark", transport: "sse", retry: { enabled: false } }));
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { verification: { baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", apiKey: "$PI_JEV_UI_KEY", models: [{ id: "scripted", name: "UI fixture primary", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
  await command("pi", ["install", repository]);
  const args = ["--no-session", "--offline", "--no-context-files", "--no-approve", "--no-skills", "--provider", "verification", "--model", "scripted", "--thinking", "off", "Verify tool presentation."];
  const json = await command("pi", ["--mode", "json", ...args]);
  const events = json.stdout.trim().split("\n").map((line) => JSON.parse(line));
  const results = events.filter((event) => event.type === "tool_execution_end");
  assert.equal(results.length, calls.length);
  for (const result of results.filter((event) => event.result.details)) assert.deepEqual(result.result.structuredContent, result.result.details);
  const totals = results.reduce((sum, event) => sum + (event.result.usage?.totalTokens ?? 0), 0);
  assert.equal(totals, 300); // 5 single judgments + 7 successful batch files.
  assert(Math.abs(results.reduce((sum, event) => sum + (event.result.usage?.cost.total ?? 0), 0) - 0.0012) < 1e-9);
  assert.equal(results.filter((event) => event.isError).length, 2);
  const shellQuote = (arg: string) => `'${arg.replaceAll("'", "'\\''")}'`;
  const tui = await command("script", ["--quiet", "--return", "--command", `stty cols 120 rows 80; exec pi ${args.map(shellQuote).join(" ")}`, "/dev/null"], true);
  const visible = stripVTControlCharacters(tui.stdout);
  for (const forbidden of ["input_tokens", "output_tokens", "state_summary", "probabilities", "legend", "questions_json", '"answers":', '"usage":']) assert(!visible.includes(forbidden), `Raw field appeared in TUI: ${forbidden}`);
  for (const expected of ["No · 76%", "Security boundary · 54%", "Complex / likely bug · 90%", "src/a.ts", "src/g.ts", "1 failed", "HTTP 500", "not found", "1 more results"]) assert(visible.includes(expected), `Missing human output: ${expected}`);
  assert.equal(verifiedResponses, 2);
  console.log("PASS: isolated installed Pi JSON + interactive sessions; all six tools, partial/complete errors, real expanded TUI, complete model payloads, 300 nested tokens and $0.0012 fixture cost.");
} finally { server.close(); await rm(root, { recursive: true, force: true }); }
