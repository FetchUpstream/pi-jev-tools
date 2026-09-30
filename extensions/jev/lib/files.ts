// Bounded, cooperatively cancellable discovery. Explicit files obey the same safety rules.
import { glob, open, readFile, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { LIMITS } from "./types.ts";

export const MAX_FILE_CHARS = LIMITS.PER_QUESTION_TOKEN_BUDGET * 4; // Early raw-size ceiling; serialized request is checked separately.
export const MAX_DISCOVERED_ENTRIES = 10_000;
export const MAX_SKIPPED_EXAMPLES = 100;
export const MAX_MODEL_SKIPPED_EXAMPLES = 5;
export const SKIP_DIRS = new Set(["node_modules", ".git", ".sessions", "dist", "build", "coverage", ".pi"]);
export const LOCKFILES = new Set(["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb", "Cargo.lock", "composer.lock", "Gemfile.lock", "poetry.lock", "uv.lock", "Pipfile.lock"]);
const BINARY_EXTENSION = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|woff2?|ttf|mp[34]|mov|lock)$/i;
export interface Skipped { path: string; reason: string }
export interface SkipCounts { skipped_total: number; skipped_by_reason: Record<string, number> }
export function skipReason(reason: string) { return reason.split(":")[0]; }
export function retainSkip(target: { skipped: Skipped[] } & SkipCounts, skip: Skipped) {
  target.skipped_total++;
  const reason = skipReason(skip.reason);
  target.skipped_by_reason[reason] = (target.skipped_by_reason[reason] ?? 0) + 1;
  if (target.skipped.length < MAX_SKIPPED_EXAMPLES) target.skipped.push(skip);
}
export class FileStateError extends Error {
  constructor(message: string, readonly path: string) { super(message); this.name = "FileStateError"; }
}
function pathReason(path: string, cwd: string): string | undefined {
  const rel = relative(cwd, path);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return "outside the workspace";
  const parts = rel.split(sep);
  if (parts.some((part) => SKIP_DIRS.has(part))) return "skipped directory";
  const name = basename(path);
  if (/^\.env(?:\.|$)/.test(name) || /\.(pem|key|p12|pfx|jks|keystore)$/i.test(name) ||
      /^(id_rsa|id_dsa|id_ecdsa|id_ed25519)(?:$|\.)/.test(name) ||
      [".npmrc", ".pypirc", ".netrc", "credentials.json", "service-account.json"].includes(name) ||
      parts.some((p) => [".ssh", ".aws", ".gnupg"].includes(p))) return "sensitive file";
}
async function inspect(path: string, cwd: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const root = await realpath(cwd);
  const full = resolve(root, path);
  const lexicalReason = pathReason(full, root);
  if (lexicalReason) throw new FileStateError(`${lexicalReason}: ${path}`, path);
  signal?.throwIfAborted();
  let actual: string;
  try { actual = await realpath(full); }
  catch { signal?.throwIfAborted(); throw new FileStateError(`not found: ${path}`, path); }
  signal?.throwIfAborted();
  const reason = pathReason(actual, root);
  if (reason) throw new FileStateError(`${reason}: ${path}`, path);
  const info = await stat(actual);
  signal?.throwIfAborted();
  if (!info.isFile()) throw new FileStateError(`not a file: ${path}`, path);
  if (LOCKFILES.has(basename(actual)) || BINARY_EXTENSION.test(actual)) throw new FileStateError(`binary or lock file: ${path}`, path);
  if (info.size === 0) throw new FileStateError(`empty: ${path}`, path);
  if (info.size > MAX_FILE_CHARS) throw new FileStateError(`too large: ${path} is ${info.size} bytes, limit ${MAX_FILE_CHARS}`, path);
  return actual;
}
export async function readFileState(path: string, cwd: string, signal?: AbortSignal) {
  const full = await inspect(path, cwd, signal);
  const buf = await readFile(full, { signal });
  signal?.throwIfAborted();
  if (buf.length > MAX_FILE_CHARS) throw new FileStateError(`too large: ${path}, limit ${MAX_FILE_CHARS}`, path);
  if (buf.subarray(0, 8192).includes(0)) throw new FileStateError(`binary: ${path}`, path);
  return { path, content: buf.toString("utf8") };
}
export interface Discovery extends SkipCounts { paths: string[]; skipped: Skipped[]; discovered_entries: number }
export async function expandPatterns(patterns: string[], cwd: string, recursive: boolean, signal?: AbortSignal): Promise<Discovery> {
  signal?.throwIfAborted();
  const out = new Set<string>();
  const metadata = { skipped: [] as Skipped[], skipped_total: 0, skipped_by_reason: {} as Record<string, number> };
  let entries = 0;
  const count = () => {
    signal?.throwIfAborted();
    if (++entries > MAX_DISCOVERED_ENTRIES) throw new Error(`Discovery exceeds ${MAX_DISCOVERED_ENTRIES} entries; narrow the patterns.`);
  };
  // Count excluded traversal entries as well as yielded entries: unusable trees are bounded too.
  const exclude = (path: string) => { count(); return pathReason(resolve(cwd, path), resolve(cwd)) !== undefined; };
  for (const raw of patterns) {
    count();
    const pattern = raw.trim();
    if (!pattern) continue;
    let info;
    try { info = await stat(resolve(cwd, pattern)); } catch { signal?.throwIfAborted(); }
    signal?.throwIfAborted();
    if (!info && /[*?[\]{}]/.test(pattern)) {
      let found = false;
      for await (const path of glob(pattern, { cwd, exclude })) { count(); out.add(String(path)); found = true; }
      if (!found) retainSkip(metadata, { path: pattern, reason: `no files matched: ${pattern}` });
      continue;
    }
    if (!info?.isDirectory() || exclude(pattern)) { out.add(pattern); continue; }
    let found = false;
    const directory = resolve(cwd, pattern);
    const excludeChild = (path: string) => exclude(relative(cwd, resolve(directory, path)));
    for await (const path of glob(recursive ? "**/*" : "*", { cwd: directory, exclude: excludeChild })) {
      count(); out.add(relative(cwd, resolve(directory, String(path)))); found = true;
    }
    if (!found) retainSkip(metadata, { path: pattern, reason: `no files matched: ${pattern}` });
  }
  signal?.throwIfAborted();
  return { paths: [...out].sort(), ...metadata, discovered_entries: entries };
}
async function checkBinary(path: string, actual: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const handle = await open(actual, "r");
  try {
    signal?.throwIfAborted();
    const header = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    signal?.throwIfAborted();
    if (header.subarray(0, bytesRead).includes(0)) throw new FileStateError(`binary: ${path}`, path);
  } finally { await handle.close(); }
}
export async function pruneFiles(input: string[] | Discovery, cwd: string, cap: number = LIMITS.MAX_CHOICE_OPTIONS, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const files: string[] = [];
  const paths = Array.isArray(input) ? input : input.paths;
  const metadata = Array.isArray(input) ? { skipped: [] as Skipped[], skipped_total: 0, skipped_by_reason: {} as Record<string, number> } :
    { skipped: [...input.skipped], skipped_total: input.skipped_total, skipped_by_reason: { ...input.skipped_by_reason } };
  const seen = new Set<string>();
  const root = await realpath(cwd);
  for (const path of paths) {
    signal?.throwIfAborted();
    try {
      const actual = await inspect(path, cwd, signal);
      if (seen.has(actual)) continue;
      seen.add(actual);
      await checkBinary(path, actual, signal);
      if (files.length >= cap) throw new FileStateError(`over the ${cap} file cap; narrow the pattern`, path);
      files.push(relative(root, actual));
    } catch (error) {
      signal?.throwIfAborted();
      retainSkip(metadata, { path, reason: error instanceof Error ? error.message : "file unavailable" });
    }
  }
  signal?.throwIfAborted();
  return { files, ...metadata };
}
/** Stop scheduling on failure/abort, and join ALL workers before rejecting. */
export async function parallel<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>, signal?: AbortSignal): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) throw new Error("Concurrency must be a positive integer.");
  signal?.throwIfAborted();
  const out: R[] = new Array(items.length);
  let next = 0, stopped = false;
  const worker = async () => {
    try {
      while (!stopped && next < items.length) { signal?.throwIfAborted(); const i = next++; out[i] = await fn(items[i]); }
    } catch (error) { stopped = true; throw error; }
  };
  const settled = await Promise.allSettled(Array.from({ length: Math.min(limit, items.length) }, worker));
  signal?.throwIfAborted();
  const failure = settled.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
  return out;
}
