import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { commandArgs, runSafeCommand } from "../extensions/jev/lib/command.ts";
import type { Decide } from "../extensions/jev/lib/client.ts";
import { askJev } from "../extensions/jev/tools/ask-jev.ts";
import { fakeDecide, fixture, Q_JSON } from "./support.ts";
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const safe: Decide = fakeDecide;
test("policy allows only documented git reads and flags", () => {
  for (const command of ["git status --short --branch", "git diff --stat", "git diff --cached -U3 HEAD -- src/auth.ts", 'git diff -- "src/space name.ts"', "git log --oneline -n5", "git show HEAD", "git ls-files --others --exclude-standard"]) expect(commandArgs(command)[0]).toBe(command.split(" ")[1]);
});
test("implicit cwd pathspec is added only when no path operand exists", () => {
  for (const [command, expected] of [
    ["git ls-files a.ts", ["ls-files", "a.ts"]],
    ["git status --short a.ts", ["status", "--short", "a.ts"]],
    ["git diff -- a.ts", ["diff", "--", "a.ts"]],
    ["git diff HEAD -- a.ts", ["diff", "HEAD", "--", "a.ts"]],
    ["git diff", ["diff", "--", "."]],
    ["git status --short", ["status", "--short", "--", "."]],
    ["git diff HEAD", ["diff", "HEAD", "--", "."]],
    ["git diff HEAD~1 --", ["diff", "HEAD~1", "--", "."]],
    ["git ls-files --", ["ls-files", "--", "."]],
    ["git status --short -- -s", ["status", "--short", "--", "-s"]],
    ["git ls-files -- --", ["ls-files", "--", "--"]],
    ["git diff -- --", ["diff", "--", "--"]],
  ] as const) expect(commandArgs(command)).toEqual([...expected]);
  for (const command of ["git diff a.ts", "git diff main", "git show refs/heads/main", "git status -- ../a.ts"]) expect(() => commandArgs(command)).toThrow();
});
test("real targeted Git reads exclude other changed files", async () => {
  const dir = await fixture({ "a.ts": "a", "b.ts": "b" }); dirs.push(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"], { cwd: dir });
  await writeFile(join(dir, "a.ts"), "changed a");
  await writeFile(join(dir, "b.ts"), "changed b");
  for (const command of ["git ls-files a.ts", "git status --short a.ts", "git diff -- a.ts", "git diff HEAD -- a.ts"]) {
    const result = await runSafeCommand(command, dir);
    expect(result.exit_code).toBe(0);
    expect(result.stdout).toContain("a.ts");
    expect(result.stdout).not.toContain("b.ts");
  }
  for (const command of ["git diff", "git status --short"]) expect((await runSafeCommand(command, dir)).stdout).toContain("b.ts");
});
test("a second separator is a literal pathspec, not permission to broaden", async () => {
  const dir = await fixture({ "--": "dash", "other.ts": "other" }); dirs.push(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["add", "."], { cwd: dir });
  const result = await runSafeCommand("git ls-files -- --", dir);
  expect(result.exit_code).toBe(0);
  expect(result.stdout).toBe("--\n");
});
for (const command of ["rm -rf x", "git reset --hard", "git clean -fd", "git push --force", "npm test", "bun test", "node -e 'x'", "git -c alias.x=x status", "git status; rm x", "git status && rm x", "git status | cat", "git diff > out", "git show $(id)", "git show `id`", "git status\nrm x", "git diff --output=out", "git diff --ext-diff", "git show --textconv", "git diff --no-index a b", "git diff ../../outside", "git diff /etc/passwd", "git show --format=%x00", 'git diff "unclosed']) {
  test(`policy rejects ${JSON.stringify(command)}`, () => { expect(() => commandArgs(command)).toThrow(); });
}
test("read-only Git needs no Jev authorization; unknown commands are refused", async () => {
  const dir = await fixture(); dirs.push(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  await expect(runSafeCommand("git reset --hard", dir)).rejects.toThrow("command refused");
  expect((await runSafeCommand("git status", dir)).exit_code).toBe(0);
  let calls = 0;
  await askJev({ command: "git status", questions_json: Q_JSON }, dir, async (s, q) => {
    calls++; expect(Object.keys(q)).toEqual(["q"]); return fakeDecide(s, q);
  });
  expect(calls).toBe(1);
});
test("real git output stays internal; external diff and fsmonitor are disabled", async () => {
  const dir = await fixture({ "a.ts": "const a = 1;" }); dirs.push(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["add", "a.ts"], { cwd: dir });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"], { cwd: dir });
  await writeFile(join(dir, "a.ts"), "const a = 2;");
  // These commands would write files if Git invoked repo-defined external helpers.
  execFileSync("git", ["config", "diff.external", "touch diff-marker"], { cwd: dir });
  execFileSync("git", ["config", "core.fsmonitor", "touch monitor-marker"], { cwd: dir });
  const diff = await runSafeCommand("git diff", dir);
  expect(diff.stdout).toContain("+const a = 2;");
  expect(diff.exit_code).toBe(0);
  const status = await runSafeCommand("git status --short", dir);
  expect(status.stdout).toContain("a.ts");
  expect(status.stdout).not.toContain("marker");
  const r = await askJev({ command: "git diff", questions_json: Q_JSON }, dir, safe);
  expect(JSON.stringify(r)).not.toContain("const a");
  for (const command of ["git log --oneline -n1", "git show --stat HEAD", "git ls-files"]) expect((await runSafeCommand(command, dir)).exit_code).toBe(0);
});

test("nested workspaces reject Git object operands and scope implicit reads to cwd", async () => {
  const dir = await fixture({ "app/inside.txt": "INSIDE_MARKER", "outside.txt": "OUTSIDE_MARKER" }); dirs.push(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"], { cwd: dir });
  const cwd = join(dir, "app");
  for (const command of ["git show HEAD:outside.txt", "git show HEAD:../outside.txt", "git show HEAD^{tree}", "git diff HEAD:outside.txt HEAD:app/inside.txt", "git show :/fixture", "git show -- :../outside.txt"]) {
    await expect(runSafeCommand(command, cwd)).rejects.toThrow("command refused");
  }
  await writeFile(join(dir, "outside.txt"), "OUTSIDE_CHANGED");
  await writeFile(join(cwd, "inside.txt"), "INSIDE_CHANGED");
  for (const command of ["git show HEAD", "git show --stat HEAD", "git log -n1", "git diff", "git diff HEAD -- inside.txt", "git status --short", "git ls-files"]) {
    const result = await runSafeCommand(command, cwd);
    expect(result.exit_code).toBe(0);
    expect(result.stdout).not.toContain("OUTSIDE");
    expect(result.stdout).not.toContain("outside.txt");
    if (!command.startsWith("git log")) expect(result.stdout).toContain("inside.txt");
  }
});
