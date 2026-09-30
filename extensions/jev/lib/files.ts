// File discovery, filtering and budgets adapted from Ten Levels of Jev (MIT).
import { glob, open, readFile, realpath, stat } from "node:fs/promises";
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

export interface Discovery { paths: string[]; skipped: Skipped[] }

export async function expandPatterns(patterns: string[], cwd: string, recursive: boolean): Promise<Discovery> {
  const out = new Set<string>();
  const skipped: Skipped[] = [];
  // Prune known junk during traversal, not only after enumerating a dependency tree.
  const exclude = (path: string) => pathReason(resolve(cwd, path), resolve(cwd)) !== undefined;
  for (const raw of patterns) {
    const pattern = raw.trim();
    if (!pattern) continue;
    let info;
    try { info = await stat(resolve(cwd, pattern)); } catch { /* May be a glob. */ }
    // An existing literal path wins, including filenames such as [id].ts.
    if (!info && /[*?[\]{}]/.test(pattern)) {
      let found = false;
      for await (const path of glob(pattern, { cwd, exclude })) { out.add(String(path)); found = true; }
      if (!found) skipped.push({ path: pattern, reason: `no files matched: ${pattern}` });
      continue;
    }
    if (!info?.isDirectory() || exclude(pattern)) { out.add(pattern); continue; }
    let found = false;
    // The path already exists: make it glob's cwd, never part of its pattern.
    // User glob inputs above remain untouched, including character classes/braces.
    const directory = resolve(cwd, pattern);
    const excludeChild = (path: string) => exclude(relative(cwd, resolve(directory, path)));
    for await (const path of glob(recursive ? "**/*" : "*", { cwd: directory, exclude: excludeChild })) {
      out.add(relative(cwd, resolve(directory, String(path)))); found = true;
    }
    if (!found) skipped.push({ path: pattern, reason: `no files matched: ${pattern}` });
  }
  return { paths: [...out].sort(), skipped };
}

async function checkBinary(path: string, actual: string) {
  const handle = await open(actual, "r");
  try {
    const header = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (header.subarray(0, bytesRead).includes(0)) throw new FileStateError(`binary: ${path}`, path);
  } finally { await handle.close(); }
}

export async function pruneFiles(input: string[] | Discovery, cwd: string, cap: number = LIMITS.MAX_CHOICE_OPTIONS) {
  const files: string[] = [];
  const paths = Array.isArray(input) ? input : input.paths;
  const skipped: Skipped[] = Array.isArray(input) ? [] : [...input.skipped];
  const seen = new Set<string>();
  const root = await realpath(cwd);
  for (const path of paths) {
    try {
      const actual = await inspect(path, cwd);
      if (seen.has(actual)) continue;
      seen.add(actual);
      await checkBinary(path, actual);
      if (files.length >= cap) throw new FileStateError(`over the ${cap} file cap; narrow the pattern`, path);
      files.push(relative(root, actual));
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
