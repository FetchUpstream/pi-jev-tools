// Opt-in behavioral check: an UNSCRIPTED real primary model chooses every tool.
// Only Jev's transport is mocked against a known synthetic repository; no paid Jev call.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

if (process.env.JEV_POLICY_LIVE !== "1") throw new Error("Real-primary verification is opt-in. Run bun run verify:behavior -- provider/model.");
const model = process.argv.slice(2).find((arg) => arg !== "--") ?? (process.env.PI_PROVIDER && process.env.PI_MODEL ? `${process.env.PI_PROVIDER}/${process.env.PI_MODEL}` : undefined);
if (!model) throw new Error("Pass a configured primary provider/model; this check may consume primary-model quota.");
const repository = fileURLToPath(new URL("../", import.meta.url));
const root = await mkdtemp(join(tmpdir(), "pi-jev-behavior-"));
const workspace = join(root, "project");
const agentDir = join(root, "agent");
const tracePath = join(root, "transport.jsonl");
const preload = join(root, "jev-fixture.mjs");
const env: NodeJS.ProcessEnv = {
  ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1",
  TYPESAFE_API_KEY: "fixture-only-placeholder", JEV_BACKEND: "typesafe",
  NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
};
delete env.OPENROUTER_API_KEY;

async function command(args: string[]) {
  const child = spawn("pi", args, { cwd: workspace, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 180_000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
    assert.equal(code, 0, `Pi invocation failed: ${stderr}`);
    return stdout;
  } finally { clearTimeout(timer); }
}

function source(index: number) {
  const header = `export interface Row { key: string; changedAt: number; amount: number; handle: { close(): void } }\n`;
  let main = `export function process(rows: Row[]) { return rows.map(row => ({ ...row, amount: Math.round(row.amount * 100) / 100 })); }\n`;
  if (index === 11) main = `export function process(rows: Row[], now: number) { return rows.filter(row => row.changedAt + 3_600_000 >= now); }\n`;
  if (index === 28) main = `export function process(rows: Row[], current: Set<string>) { for (const row of rows) { if (!current.has(row.key)) row.handle.close(); } return rows.filter(row => current.has(row.key)); }\n`;
  if (index === 35) main += `export const label = "EXACT_SEARCH_SENTINEL_7";\n`;
  const helpers = Array.from({ length: 24 }, (_, i) => `export function metric${i}(rows: Row[]) { return rows.reduce((sum, row) => sum + row.amount * ${i + 1}, 0); }`).join("\n");
  return header + main + helpers + "\n";
}

// This preload never decides the primary model's tool calls and never changes tool results
// through Pi hooks. It intercepts only the real Jev client's fixed network endpoint.
const mockTransport = `
import { appendFileSync } from "node:fs";
import { zstdDecompressSync } from "node:zlib";
let delegateFetch = globalThis.fetch;
const trace = ${JSON.stringify(tracePath)};
const log = (data) => appendFileSync(trace, JSON.stringify(data) + "\\n");
async function fixtureFetch(input, init) {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url !== "https://api.typesafe.ai/v1/systemone") {
    let bodyText = "";
    if (typeof init?.body === "string") bodyText = init.body;
    else if (init?.body && new Headers(init.headers).get("content-encoding") === "zstd") bodyText = zstdDecompressSync(init.body).toString("utf8");
    if (bodyText.includes("## Jev usage policy")) {
      log({ kind: "primary", policyCount: bodyText.split("## Jev usage policy").length - 1 });
    }
    return delegateFetch(input, init);
  }
  const body = JSON.parse(init.body);
  const path = body.state.path ?? "";
  const relevant = /module-(11|28)\\.ts$/.test(path) || Object.keys(body.state.files ?? {}).some(p => /module-(11|28)\\.ts$/.test(p));
  log({ kind: "jev-mock", path });
  const answers = Object.fromEntries(Object.entries(body.questions).map(([id, q]) => {
    if (q.type === "noul") return [id, { type: "noul", noul: relevant ? 0.98 : 0.02 }];
    const keys = q.type === "choice" ? Object.keys(q.criteria) : q.criteria.map((_, i) => String(i));
    const exit = keys.find(k => /^(other|none|irrelevant|unrelated|not_relevant|no)$/i.test(k)) ?? keys[keys.length - 1];
    const positive = keys.find(k => /module-(11|28)\\.ts$/.test(k)) ?? keys.find(k => k !== exit) ?? keys[0];
    let selected;
    if (q.type === "choice") selected = relevant || positive.includes("module-") ? positive : exit;
    else selected = keys[relevant ? keys.length - 1 : 0];
    const probabilities = Object.fromEntries(keys.map(k => [k, k === selected ? 1 : 0]));
    if (q.type === "choice") return [id, { type: "choice", choice: selected, confidence: 0.98, probabilities }];
    return [id, { type: "score", score: Number(selected), confidence: 0.98, probabilities, legend: Object.fromEntries(q.criteria.map((level, i) => [String(i), level])) }];
  }));
  return Response.json({ model: "jev-fixture-mock", answers, usage: { input_tokens: 20, output_tokens: 5, cost: 0 } });
}
// Pi installs its own fetch dispatcher at startup; retain the fixture interception
// while forwarding non-Jev traffic through whichever fetch implementation Pi installs.
Object.defineProperty(globalThis, "fetch", {
  configurable: true,
  get: () => fixtureFetch,
  set: (implementation) => { if (implementation !== fixtureFetch) delegateFetch = implementation; },
});
`;

async function investigate(name: string, prompt: string) {
  await writeFile(tracePath, "");
  const output = await command(["--mode", "json", "--no-session", "--no-context-files", "--no-approve", "--no-skills", "--no-prompt-templates", "--model", model!, "--thinking", "low", "--tools", "read,bash,grep,find,ls,ask_jev,ask_jev_files,pick_first_file,ask_jev_file_bool,ask_jev_file_choice,ask_jev_file_score", prompt]);
  const events = output.trim().split("\n").map((line) => JSON.parse(line));
  const calls = events.filter((event) => event.type === "tool_execution_start");
  const failures = events.filter((event) => event.type === "tool_execution_end" && event.isError);
  // Exploratory shell probes may legitimately return nonzero (e.g. no node_modules).
  // Read/Jev failures are regressions; the reproduction below must itself succeed.
  const unexpected = failures.filter((event) => event.toolName !== "bash");
  assert.equal(unexpected.length, 0, `${name}: tools failed: ${JSON.stringify(unexpected)}`);
  const assistantErrors = events.filter((event) => event.type === "message_end" && ["error", "aborted"].includes(event.message?.stopReason));
  assert.equal(assistantErrors.length, 0, `${name}: primary model failed: ${JSON.stringify(assistantErrors)}`);
  const trace = (await readFile(tracePath, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const primary = trace.filter((event) => event.kind === "primary");
  assert(primary.length > 0, `${name}: no primary request carried the policy`);
  assert(primary.every((event) => event.policyCount === 1), `${name}: duplicated policy in a primary request`);
  console.log(`${name} tools: ${calls.map((call) => call.toolName).join(" → ")}`);
  return { calls, trace, events };
}

try {
  await mkdir(join(workspace, "src"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(preload, mockTransport);
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ transport: "sse", retry: { enabled: false } }));
  // Reuse configured authentication without printing, copying or committing credentials.
  const userAgent = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  await symlink(join(userAgent, "auth.json"), join(agentDir, "auth.json"));
  await symlink(join(userAgent, "models-store.json"), join(agentDir, "models-store.json"));
  for (let i = 0; i < 48; i++) await writeFile(join(workspace, "src", `module-${String(i).padStart(2, "0")}.ts`), source(i));
  await command(["install", repository]);

  const semantic = await investigate("semantic code review", "Review this repository for correctness defects in how obsolete records are eliminated and associated handles released. Identify the implementation modules with file/line references. Confirm any reported defect with an executable reproduction. Do not change files.");
  const filterIndex = semantic.calls.findIndex((call) => call.toolName === "ask_jev_files");
  assert(filterIndex >= 0, "The primary model did not proactively use ask_jev_files for semantic filtering.");
  assert(semantic.calls.slice(0, filterIndex).some((call) => ["find", "ls", "grep", "bash"].includes(call.toolName)), "No deterministic discovery before semantic filtering.");
  const readsBefore = semantic.calls.slice(0, filterIndex).filter((call) => call.toolName === "read");
  for (const call of semantic.calls.filter((call) => call.toolName === "ask_jev_files")) {
    const questions: Record<string, { type: string }> = JSON.parse(call.args.questions_json);
    assert(Object.values(questions).every((question) => ["noul", "choice"].includes(question.type)), "Ordinary repository triage used score rather than noul/choice.");
  }
  assert.equal(readsBefore.length, 0, "Primary loaded files before semantic filtering.");
  const readPaths = semantic.calls.filter((call) => call.toolName === "read").map((call) => call.args.path);
  assert(readPaths.some((path) => /module-(11|28)\.ts$/.test(path)), "Primary did not read selected implementation details.");
  assert(readPaths.every((path) => /module-(11|28)\.ts$/.test(path)), "Primary read an unselected fixture module.");
  assert(new Set(readPaths).size < 48, "Primary read the entire candidate corpus.");
  const lastRead = semantic.calls.findLastIndex((call) => call.toolName === "read");
  assert(semantic.calls.slice(lastRead + 1).some((call) => call.toolName === "bash" && /\b(node|bun|python3?)\b/.test(call.args.command) && semantic.events.some((event) => event.type === "tool_execution_end" && event.toolCallId === call.toolCallId && !event.isError)), "Review lacked a successful executable deterministic reproduction after source inspection.");
  assert(!semantic.calls.some((call) => call.toolName === "bash" && /(?:cat|head|tail|sed).*src\/\*/.test(call.args.command)), "Primary loaded candidate corpus through bash.");
  const judged = new Set(semantic.trace.filter((event) => event.kind === "jev-mock").map((event) => event.path).filter(Boolean));
  assert(judged.size > 1, "Primary did not batch semantic judgments across candidate files.");
  console.log(`PASS: real ${model} discovered candidates, judged ${judged.size} files via mocked Jev, then read ${new Set(readPaths).size}/48 files; no user Jev instruction.`);

  const deterministic = await investigate("exact search", "Find every occurrence of the exact literal EXACT_SEARCH_SENTINEL_7 under src. Return matching filenames and line numbers. Do not interpret the code or change files.");
  assert(deterministic.calls.some((call) => ["grep", "bash"].includes(call.toolName)), "No deterministic search tool was used.");
  assert(!deterministic.calls.some((call) => /^(ask_jev|pick_first_file)/.test(call.toolName)), "Exact search unnecessarily called Jev.");
  assert(!deterministic.trace.some((event) => event.kind === "jev-mock"), "Exact search reached Jev's transport.");
  console.log("PASS: exact literal search used deterministic tooling with zero Jev calls.");
} finally {
  await rm(root, { recursive: true, force: true });
}
