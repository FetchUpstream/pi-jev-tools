// End-to-end proof through the installed Pi CLI, not direct extension imports.
// A loopback scripted PRIMARY model issues real tool calls. Jev keys are absent:
// no paid calls, credential copying, or extra -e verification extensions.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../", import.meta.url));
const root = await mkdtemp(join(tmpdir(), "pi-jev-install-"));
const cwd = resolve(tmpdir());
const source = "git:github.com/FetchUpstream/pi-jev-tools";
const expected = ["ask_jev", "ask_jev_files", "pick_first_file", "ask_jev_file_bool", "ask_jev_file_choice", "ask_jev_file_score"];
const env: NodeJS.ProcessEnv = { ...process.env, PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1", PI_JEV_VERIFY_KEY: "loopback-placeholder" };
for (const key of ["TYPESAFE_API_KEY", "OPENROUTER_API_KEY", "JEV_BACKEND", "JEV_LIVE"]) delete env[key];
const questions_json = JSON.stringify({ q: { type: "noul", instructions: "Does the state mention tokens?" } });
const path = relative(cwd, join(root, "input.ts"));
const calls = [
  { name: "ask_jev_file_bool", arguments: { path, question: "Does `content` validate tokens?" } },
  { name: "ask_jev_files", arguments: { paths_or_globs: [relative(cwd, join(root, "*.ts"))], questions_json } },
  { name: "ask_jev", arguments: { paths: [path], state: "Customer reports invalid tokens", questions_json } },
  { name: "ask_jev_file_choice", arguments: { path, question: "Which layer?", options: { auth: "Token validation" } } },
  { name: "ask_jev_file_score", arguments: { path, question: "How risky?", levels: ["isolated", "security sensitive"] } },
  { name: "pick_first_file", arguments: { question: "Where first?", candidates: [{ path }] } },
];
let requests = 0;
let serverError: Error | undefined;
const server = createServer(async (req, res) => {
  try {
    let body = "";
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body);
    const declared = payload.tools.map((t: { function: { name: string } }) => t.function.name);
    for (const name of expected) assert(declared.includes(name), `Not declared to model: ${name}`);
    assert(JSON.stringify(payload.messages).includes("Use ask_jev for cheap bounded judgments"), "Delegation guideline missing");
    const first = requests++ === 0;
    if (!first) {
      const results = payload.messages.filter((m: { role: string }) => m.role === "tool");
      assert.equal(results.length, 6);
      for (const result of results) assert(JSON.stringify(result).includes("Jev is not configured. Set TYPESAFE_API_KEY or OPENROUTER_API_KEY."));
    }
    const delta = first ? { role: "assistant", tool_calls: calls.map((call, index) => ({ index, id: `verify_${index}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) }
      : { role: "assistant", content: "Verification completed." };
    const chunk = (delta: unknown, finish_reason: string | null) => ({ id: "verification", object: "chat.completion.chunk", created: 1, model: "scripted", choices: [{ index: 0, delta, finish_reason }] });
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(`data: ${JSON.stringify(chunk(delta, null))}\n\ndata: ${JSON.stringify(chunk({}, first ? "tool_calls" : "stop"))}\n\ndata: [DONE]\n\n`);
  } catch (error) {
    serverError = error as Error;
    res.writeHead(500); res.end("Verification assertion failed.");
  }
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert(address && typeof address !== "string");
const port = address.port;

async function command(program: string, args: string[], extra: NodeJS.ProcessEnv = {}) {
  const child = spawn(program, args, { cwd, env: { ...env, ...extra }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 90_000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
    assert.equal(code, 0, `${program} ${args.join(" ")} failed: ${stderr}`);
    return { stdout, stderr };
  } finally { clearTimeout(timer); }
}
async function verify(agentDir: string, source: string, extra: NodeJS.ProcessEnv = {}) {
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { verification: {
    baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "$PI_JEV_VERIFY_KEY",
    models: [{ id: "scripted", name: "Scripted verification primary model", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  } } }));
  const scoped = { ...extra, PI_CODING_AGENT_DIR: agentDir };
  await command("pi", ["install", source], scoped);
  const list = await command("pi", ["list"], scoped);
  assert(list.stdout.includes(source.replace(/\/+$/, "")), `Package missing from pi list: ${list.stdout}`);
  requests = 0; serverError = undefined;
  const run = await command("pi", ["--mode", "json", "--no-session", "--offline", "--no-context-files", "--no-approve", "--provider", "verification", "--model", "scripted", "--thinking", "off", "Verify installed Jev tool contracts."], scoped);
  if (serverError) throw serverError;
  assert(!/Failed to load|extension error|duplicate/i.test(run.stderr), run.stderr);
  const events = run.stdout.trim().split("\n").map((line) => JSON.parse(line));
  const results = events.filter((event) => event.type === "tool_execution_end");
  assert.equal(results.length, 6, `Expected six executions; stderr: ${run.stderr}`);
  for (const name of expected) {
    const result = results.find((event) => event.toolName === name);
    assert(result?.isError, `${name} should fail at the configuration boundary`);
    assert(JSON.stringify(result.result).includes("Jev is not configured. Set TYPESAFE_API_KEY or OPENROUTER_API_KEY."));
  }
  assert.equal(requests, 2);
  console.log(`PASS: ${source}; all six registered, declared and executed in Node Pi from ${cwd}, without -e.`);
}

try {
  await writeFile(join(root, "input.ts"), "export function validateToken(token: string) { return token.length > 0; }\n");
  await verify(join(root, "local-agent"), repository);
  // Exercise EXACTLY the GitHub source parser/clone/dependency-install/discovery path,
  // without publishing: Git alone rewrites that one remote to this committed repository.
  const gitConfig = join(root, "gitconfig");
  await command("git", ["config", "--file", gitConfig, `url.file://${repository}.insteadOf`, "https://github.com/FetchUpstream/pi-jev-tools"]);
  const gitAgent = join(root, "git-agent");
  await verify(gitAgent, source, { GIT_CONFIG_GLOBAL: gitConfig });
  const gitRoot = join(gitAgent, "git", "github.com", "FetchUpstream", "pi-jev-tools");
  const tracked = await command("git", ["-C", gitRoot, "ls-files"]);
  assert(tracked.stdout.includes("extensions/jev/index.ts"));
  // Managed Git installation must omit both devDependencies and host peers.
  const installedModules = await readdir(join(gitRoot, "node_modules")).catch(() => []);
  assert(installedModules.every((name) => name.startsWith(".")), `Unexpected installed runtime packages: ${installedModules.join(", ")}`);
  console.log("PASS: managed Git checkout contains no duplicate host or development runtime packages. No GitHub push performed.");
} finally {
  server.close();
  await rm(root, { recursive: true, force: true });
}
