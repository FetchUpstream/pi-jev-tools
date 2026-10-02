import { afterEach, expect, test } from "bun:test";
import { rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expandPatterns, MAX_DISCOVERED_ENTRIES, MAX_FILE_CHARS, parallel, pruneFiles, readFileState, SKIP_DIRS } from "../extensions/jev/lib/files.ts";
import { fixture } from "./support.ts";
const dirs: string[] = [];
async function make(files?: Record<string, string | Buffer>) { const dir = await fixture(files); dirs.push(dir); return dir; }
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

test("glob discovery, directories, recursion, deduplication and sorting", async () => {
  const dir = await make({ "src/a.ts": "a", "src/nested/b.ts": "b", "src/c.js": "c" });
  expect((await expandPatterns(["src/**/*.ts", "src/a.ts"], dir, false)).paths).toEqual(["src/a.ts", "src/nested/b.ts"]);
  const direct = await pruneFiles(await expandPatterns(["src"], dir, false), dir);
  expect(direct.files).toEqual(["src/a.ts", "src/c.js"]);
  const recursive = await pruneFiles(await expandPatterns(["src"], dir, true), dir);
  expect(recursive.files).toEqual(["src/a.ts", "src/c.js", "src/nested/b.ts"]);
});
test("empty globs give explicit skipped reasons", async () => {
  const dir = await make();
  const r = await pruneFiles(await expandPatterns(["absent/**/*.ts"], dir, false), dir);
  expect(r.files).toEqual([]);
  expect(r.skipped[0].reason).toContain("no files matched");
});
test("generated folders, VCS/dependencies, binary/lock/empty/oversized/invalid files", async () => {
  const files: Record<string, string | Buffer> = {
    "src/ok.ts": "a", "empty.ts": "", "logo.PNG": "pretend image", "bun.lock": "lock",
    "large.txt": "x".repeat(MAX_FILE_CHARS + 1), "nul.dat": Buffer.from([1, 0, 2]),
  };
  for (const skip of SKIP_DIRS) files[`${skip}/x.ts`] = "x";
  const dir = await make(files);
  const r = await pruneFiles([...Object.keys(files), "missing.ts", "../outside.ts"], dir);
  expect(r.files).toEqual(["src/ok.ts"]);
  expect(r.skipped.length).toBe(Object.keys(files).length + 1);
  await expect(readFileState("nul.dat", dir)).rejects.toThrow("binary");
  await expect(readFileState("large.txt", dir)).rejects.toThrow("too large");
  await expect(readFileState("src", dir)).rejects.toThrow("not a file");
  await expect(readFileState("missing.ts", dir)).rejects.toThrow("not found");
  await expect(readFileState("../outside.ts", dir)).rejects.toThrow("outside");
  const broad = await expandPatterns(["**/*.ts"], dir, true);
  expect(broad.paths).toEqual(["empty.ts", "src/ok.ts"]);
});
test("cap retained; legitimate dot-dot-prefixed filenames allowed", async () => {
  const dir = await make({ "..safe.ts": "a", "b.ts": "b" });
  const r = await pruneFiles(["..safe.ts", "b.ts"], dir, 1);
  expect(r.files).toEqual(["..safe.ts"]);
  expect(r.skipped[0].reason).toContain("over the 1 file cap");
});
test("real paths prevent symlinks into junk folders or outside workspace", async () => {
  const dir = await make({ "src/a.ts": "a", "node_modules/x.ts": "junk" });
  const outside = await make({ "secret.txt": "fixture data, not credentials" });
  await symlink(join(outside, "secret.txt"), join(dir, "escape.txt"));
  await symlink(join(dir, "node_modules/x.ts"), join(dir, "alias.txt"));
  await expect(readFileState("escape.txt", dir)).rejects.toThrow("outside");
  await expect(readFileState("alias.txt", dir)).rejects.toThrow("skipped directory");
  await symlink(join(dir, "src/a.ts"), join(dir, "valid.txt"));
  expect((await readFileState("valid.txt", dir)).content).toBe("a");
});
test("parallel is ordered and bounded; invalid concurrency fails", async () => {
  let active = 0, peak = 0;
  const result = await parallel(Array.from({ length: 30 }, (_, i) => i), 4, async (i) => {
    active++; peak = Math.max(peak, active);
    await Bun.sleep(1); active--; return i * 2;
  });
  expect(result).toEqual(Array.from({ length: 30 }, (_, i) => i * 2));
  expect(peak).toBe(4);
  await expect(parallel([1], 0, async (i) => i)).rejects.toThrow("positive integer");
});

test("realpath aliases share a cap slot and a stable display path", async () => {
  const dir = await make({ "a.ts": "a", "b.ts": "b" });
  await symlink(join(dir, "a.ts"), join(dir, "alias.ts"));
  const result = await pruneFiles(["a.ts", "./a.ts", join(dir, "a.ts"), "alias.ts", "b.ts"], dir, 2);
  expect(result.files).toEqual(["a.ts", "b.ts"]);
  expect(result.skipped).toEqual([]);
});

test("existing metacharacter directories stay literal while user globs still expand", async () => {
  const names = ["[id]", "[slug]", "{admin}", "foo*"];
  const files = Object.fromEntries(names.flatMap((name) => [
    [`src/${name}/${name === "[slug]" ? "index" : name === "foo*" ? "literal" : "page"}.ts`, "code"],
    [`src/${name}/nested/deep.ts`, "deep"],
    [`src/${name}/node_modules/junk.ts`, "junk"],
    [`src/${name}/binary.dat`, Buffer.from([0])],
  ]));
  const dir = await make(files);
  for (const name of names) {
    const base = `src/${name}`;
    const direct = await pruneFiles(await expandPatterns([base], dir, false), dir);
    expect(direct.files).toEqual(Object.keys(files).filter((path) => path.startsWith(`${base}/`) && path.endsWith(".ts") && !path.includes("/nested/") && !path.includes("/node_modules/")));
    const recursive = await pruneFiles(await expandPatterns([base, base], dir, true), dir, 2);
    expect(recursive.files).toHaveLength(2);
    expect(recursive.files.every((path) => path.startsWith(`${base}/`))).toBe(true);
    expect(recursive.skipped.some((skip) => skip.reason.includes("binary"))).toBe(true);
    expect(recursive.skipped.some((skip) => skip.path.includes("node_modules"))).toBe(false);
  }
  const globbed = await pruneFiles(await expandPatterns(["src/**/*.ts"], dir, false), dir);
  expect(globbed.files).toHaveLength(8);
  const outside = await make({ "secret.ts": "outside" });
  await symlink(outside, join(dir, "src/[escape]"));
  const escaped = await pruneFiles(await expandPatterns(["src/[escape]"], dir, true), dir);
  expect(escaped.files).toEqual([]);
  expect(escaped.skipped.some((skip) => skip.reason.includes("outside"))).toBe(true);
});

test("directory and glob discovery count files once and still enforce the entry limit", async () => {
  const count = 5100;
  const dir = await make(Object.fromEntries(Array.from({ length: count }, (_, i) => [`f${i}.ts`, "code"])));
  const globbed = await expandPatterns(["*.ts"], dir, true);
  const directory = await expandPatterns(["."], dir, true);
  expect(directory.paths).toEqual(globbed.paths);
  expect(directory.discovered_entries).toBe(count + 1); // Files and the explicitly requested directory.
  const repeated = await expandPatterns([".", ".", "./", "f0.ts"], dir, true);
  expect(repeated.discovered_entries).toBe(directory.discovered_entries);
  await parallel(Array.from({ length: MAX_DISCOVERED_ENTRIES - count + 1 }, (_, i) => i), 32,
    (i) => writeFile(join(dir, `z${i}.ts`), "code"));
  for (const pattern of [".", "*.ts"]) {
    await expect(expandPatterns([pattern], dir, true)).rejects.toThrow(`Discovery exceeds ${MAX_DISCOVERED_ENTRIES} entries`);
  }
}, 20_000);

test("excluded traversal entries count once even across overlapping patterns", async () => {
  const dir = await make({ "a.ts": "code", "build/junk.ts": "generated" });
  const once = await expandPatterns(["."], dir, true);
  const result = await expandPatterns([".", "./", "a.ts"], dir, true);
  expect(result.paths).toEqual(["a.ts"]);
  expect(result.discovered_entries).toBe(once.discovered_entries);
  expect(result.discovered_entries).toBeGreaterThan(result.paths.length + 1); // Also count excluded traversal entries.
});
