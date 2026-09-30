import { execFile } from "node:child_process";
import { devNull } from "node:os";
import type { CommandOutput } from "./assemble.ts";
const BLOCK_NOTICE = "Use Pi's visible bash tool for commands outside the read-only Git allowlist.";

const COMMON = new Set(["--", "--stat", "--numstat", "--shortstat", "--name-only", "--name-status", "--oneline", "--color=never"]);
const FLAGS: Record<string, Set<string>> = {
  status: new Set(["--", "--short", "-s", "--branch", "-b", "--porcelain", "--porcelain=v1", "--porcelain=v2", "--untracked-files=no", "--untracked-files=normal", "--untracked-files=all"]),
  diff: new Set([...COMMON, "--check", "--cached", "--staged", "-w", "--ignore-space-at-eol", "--ignore-space-change"]),
  log: new Set([...COMMON, "--all", "--decorate", "--no-decorate", "--reverse", "--no-merges"]),
  show: new Set([...COMMON, "--check"]),
  "ls-files": new Set(["--", "--cached", "--modified", "--others", "--exclude-standard", "--stage", "--unmerged", "--eol", "--full-name"]),
};

/** Deliberately not a shell parser. Quotes only group spaces; no escapes or expansion. */
export function commandArgs(command: string): string[] {
  if (/[\r\n\0\\`$;&|<>(){}]/.test(command)) throw new Error("Shell syntax, substitutions, redirection and command chaining are not permitted.");
  const tokens: string[] = [];
  let token = "", quote = "", started = false;
  for (const char of command.trim()) {
    if (quote) {
      if (char === quote) quote = ""; else token += char;
      started = true;
    } else if (char === "'" || char === '"') { quote = char; started = true; }
    else if (/\s/.test(char)) { if (started) tokens.push(token); token = ""; started = false; }
    else { token += char; started = true; }
  }
  if (quote) throw new Error("Unclosed command quote.");
  if (started) tokens.push(token);
  if (tokens[0] !== "git" || !Object.hasOwn(FLAGS, tokens[1] ?? "")) {
    throw new Error("Only git status, diff, log, show and ls-files are permitted. Use Pi's visible bash tool for scripts/tests.");
  }
  const subcommand = tokens[1];
  let pathsOnly = subcommand === "status" || subcommand === "ls-files";
  let explicitPaths = false, hasPathspec = false;
  for (const arg of tokens.slice(2)) {
    const numericFlag = (subcommand === "log" || subcommand === "show") && /^(?:-n\d+|--max-count=\d+)$/.test(arg)
      || (subcommand === "diff" || subcommand === "show") && /^-U\d+$/.test(arg);
    if (arg.startsWith("-") && !FLAGS[subcommand].has(arg) && !numericFlag) throw new Error(`Unsupported ${subcommand} flag: ${arg}`);
    if (!arg || arg.startsWith("/") || arg.includes(":") || arg.split("/").includes("..")) throw new Error("Command operands must stay in the workspace; Git revision:path operands are unsupported.");
    if (arg === "--" && !explicitPaths) { pathsOnly = true; explicitPaths = true; continue; }
    if (!arg.startsWith("-") && !pathsOnly && !/^HEAD(?:~\d*|\^\d*)*$/.test(arg)) {
      throw new Error("Only HEAD commit revisions are supported; put workspace paths after --.");
    }
    if (pathsOnly && (explicitPaths || !arg.startsWith("-"))) hasPathspec = true;
  }
  // Scope implicit repository reads to cwd, but never add to an existing pathspec.
  if (!hasPathspec) {
    if (!explicitPaths) tokens.push("--");
    tokens.push(".");
  }
  return tokens.slice(1);
}

/** Execute only the deterministic read-only language, never a shell or model authorization. */
export async function runSafeCommand(command: string, cwd: string, signal?: AbortSignal): Promise<CommandOutput> {
  let args: string[];
  try { args = commandArgs(command); }
  catch (error) { throw new Error(`ask_jev command refused: ${error instanceof Error ? error.message : "Invalid command."} ${BLOCK_NOTICE}`); }
  signal?.throwIfAborted();
  const globalArgs = ["--no-pager", "-c", "core.fsmonitor=false", "-c", `core.hooksPath=${devNull}`, "-c", "core.quotePath=true"];
  if (["diff", "log", "show"].includes(args[0])) args = [args[0], "--no-ext-diff", "--no-textconv", ...args.slice(1)];
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: process.env.HOME,
    LANG: "C", CI: "1", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: devNull,
    GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_LITERAL_PATHSPECS: "1",
  };
  // No provider credentials or GIT_* / shell startup overrides are inherited.
  return new Promise((resolve, reject) => {
    execFile("git", [...globalArgs, ...args], { cwd, env, signal, timeout: 60_000, maxBuffer: 200_000 * 4, encoding: "utf8" }, (error, stdout, stderr) => {
      if (signal?.aborted) { reject(signal.reason); return; }
      if (error?.killed || error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
        reject(new Error("Command exceeded its 60s/800kB capture limit. Narrow the command.")); return;
      }
      if (stdout.length > 200_000 || stderr.length > 200_000) {
        reject(new Error("Command output exceeds 200,000 characters. Narrow the command; output was not sent.")); return;
      }
      if (error && typeof error.code !== "number") { reject(new Error("Could not execute git.")); return; }
      resolve({ command, exit_code: error ? Number(error.code) : 0, stdout, stderr });
    });
  });
}
