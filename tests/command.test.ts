import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gateBash, gateBashCommand } from "../extensions/jev/lib/bash-gate.ts";
import { commandArgs, runSafeCommand } from "../extensions/jev/lib/command.ts";
import type { Decide } from "../extensions/jev/lib/client.ts";
import { askJev } from "../extensions/jev/tools/ask-jev.ts";
import { fakeDecide, fixture, Q_JSON } from "./support.ts";
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const safe: Decide = async (s, q) => {
  const r = await fakeDecide(s, q);
  if ("destructive_intent" in q) r.answers.destructive_intent = { type: "noul", noul: 0.01 };
  return r;
};
test("upstream irreversible/destructive thresholds are retained", () => {
  const effect = { type: "choice" as const, choice: "irreversible", confidence: 0.6, probabilities: {} };
  expect(gateBash({ effect, destructive_intent: { type: "noul", noul: 0 } }).block).toBe(true);
  expect(gateBash({ effect: { ...effect, choice: "read_only" }, destructive_intent: { type: "noul", noul: 0.7 } }).block).toBe(true);
  expect(gateBash({ effect: { ...effect, choice: "reversible" }, destructive_intent: { type: "noul", noul: 0.2 } }).block).toBe(false);
});
test("ask_jev strengthens the gate to refuse reversible effects", async () => {
  const reversible: Decide = async (s, q) => {
    const r = await safe(s, q);
    if (r.answers.effect.type === "choice") r.answers.effect.choice = "reversible";
    return r;
  };
  expect((await gateBashCommand("git status", "/tmp", reversible)).block).toBe(true);
});
test("policy allows only documented git reads and flags", () => {
  for (const command of ["git status --short --branch", "git diff --stat", "git diff --cached -U3 HEAD -- src/auth.ts", 'git diff -- "src/space name.ts"', "git log --oneline -n5", "git show HEAD", "git ls-files --others --exclude-standard"]) expect(commandArgs(command)[0]).toBe(command.split(" ")[1]);
});
for (const command of ["rm -rf x", "git reset --hard", "git clean -fd", "git push --force", "npm test", "bun test", "node -e 'x'", "git -c alias.x=x status", "git status; rm x", "git status && rm x", "git status | cat", "git diff > out", "git show $(id)", "git show `id`", "git status\nrm x", "git diff --output=out", "git diff --ext-diff", "git show --textconv", "git diff --no-index a b", "git diff ../../outside", "git diff /etc/passwd", "git show --format=%x00", 'git diff "unclosed']) {
  test(`policy rejects ${JSON.stringify(command)}`, () => { expect(() => commandArgs(command)).toThrow(); });
}
test("refused commands never call gate or spawn; gate failure is fail-closed", async () => {
  const dir = await fixture(); dirs.push(dir);
  await expect(runSafeCommand("git reset --hard", dir, async () => { throw new Error("must not call"); })).rejects.toThrow("command refused");
  await expect(runSafeCommand("git status", dir, async () => { throw new Error("gate unavailable"); })).rejects.toThrow("gate unavailable");
  await expect(runSafeCommand("git status", dir, fakeDecide)).rejects.toThrow("destructive intent");
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
  const diff = await runSafeCommand("git diff", dir, safe);
  expect(diff.stdout).toContain("+const a = 2;");
  expect(diff.exit_code).toBe(0);
  const status = await runSafeCommand("git status --short", dir, safe);
  expect(status.stdout).toContain("a.ts");
  expect(status.stdout).not.toContain("marker");
  const r = await askJev({ command: "git diff", questions_json: Q_JSON }, dir, safe);
  expect(JSON.stringify(r)).not.toContain("const a");
  for (const command of ["git log --oneline -n1", "git show --stat HEAD", "git ls-files"]) expect((await runSafeCommand(command, dir, safe)).exit_code).toBe(0);
});
