// File discovery, filtering and budgets adapted from Ten Levels of Jev (MIT).
import { glob, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { LIMITS } from "./types.ts";

export const MAX_FILE_CHARS = (LIMITS.TOTAL_TOKEN_BUDGET - 4000) * 4; // 240,000 bytes
export const SKIP_DIRS = new Set(["node_modules", ".git", ".sessions", "dist", "build", "coverage", ".pi"]);
const BINARY_EXTENSION = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|woff2?|ttf|mp[34]|mov|lock)$/i;
export interface Skipped { path: string; reason: string }
export class FileStateError extends Error {
  constructor(message: string, readonly path: string) { super(message); this.name = "FileStateError"; }
}

function pathReason(path: string, cwd: string): string | undefined {
  const rel = relative(cwd, path);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return "outside the workspace";
  if (rel.split(sep).some((part) => SKIP_DIRS.has(part))) return "skipped directory";
}

/** Check lexical AND real paths, so symlinks cannot bypass workspace/filter boundaries. */
async function inspect(path: string, cwd: string) {
  const root = await realpath(cwd);
  const full = resolve(root, path);
  const lexicalReason = pathReason(full, root);
  if (lexicalReason) throw new FileStateError(`${lexicalReason}: ${path}`, path);
  let actual: string;
  try { actual = await realpath(full); }
  catch { throw new FileStateError(`not found: ${path}`, path); }
  const reason = pathReason(actual, root);
  if (reason) throw new FileStateError(`${reason}: ${path}`, path);
  const info = await stat(actual);
  if (!info.isFile()) throw new FileStateError(`not a file: ${path}`, path);
  if (BINARY_EXTENSION.test(actual)) throw new FileStateError(`binary or lock file: ${path}`, path);
  if (info.size === 0) throw new FileStateError(`empty: ${path}`, path);
  if (info.size > MAX_FILE_CHARS) throw new FileStateError(`too large: ${path} is ${info.size} bytes, limit ${MAX_FILE_CHARS}`, path);
  return actual;
}

export async function readFileState(path: string, cwd: string) {
  const full = await inspect(path, cwd);
  const buf = await readFile(full);
  if (buf.length > MAX_FILE_CHARS) throw new FileStateError(`too large: ${path}, limit ${MAX_FILE_CHARS}`, path);
  if (buf.subarray(0, 8192).includes(0)) throw new FileStateError(`binary: ${path}`, path);
  return { path, content: buf.toString("utf8") };
}

export async function expandPatterns(patterns: string[], cwd: string, recursive: boolean): Promise<string[]> {
  const out = new Set<string>();
  // Prune known junk during traversal, not only after enumerating a dependency tree.
  const exclude = (path: string) => pathReason(resolve(cwd, path), resolve(cwd)) !== undefined;
  for (const raw of patterns) {
    const pattern = raw.trim();
    if (!pattern) continue;
    if (/[*?[\]{}]/.test(pattern)) {
      let found = false;
      for await (const path of glob(pattern, { cwd, exclude })) { out.add(String(path)); found = true; }
      if (!found) out.add(pattern); // prune reports empty patterns instead of silently succeeding
      continue;
    }
    let info;
    try { info = await stat(resolve(cwd, pattern)); } catch { out.add(pattern); continue; }
    if (!info.isDirectory() || exclude(pattern)) { out.add(pattern); continue; }
    let found = false;
    const base = pattern.replace(/\/+$/, "");
    for await (const path of glob(`${base}/${recursive ? "**/*" : "*"}`, { cwd, exclude })) {
      out.add(String(path)); found = true;
    }
    if (!found) out.add(pattern);
  }
  return [...out].sort();
}

export async function pruneFiles(paths: string[], cwd: string, cap: number = LIMITS.MAX_CHOICE_OPTIONS) {
  const files: string[] = [];
  const skipped: Skipped[] = [];
  for (const path of paths) {
    try {
      if (/[*?[\]{}]/.test(path)) throw new FileStateError(`no files matched: ${path}`, path);
      await inspect(path, cwd);
      if (files.length >= cap) throw new FileStateError(`over the ${cap} file cap; narrow the pattern`, path);
      files.push(path);
    } catch (error) {
      skipped.push({ path, reason: error instanceof Error ? error.message : "file unavailable" });
    }
  }
  return { files, skipped };
}

/** Stable results with the upstream default of at most 16 simultaneous requests. */
export async function parallel<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) throw new Error("Concurrency must be a positive integer.");
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
