// Batch judgments adapted from Ten Levels of Jev, level 9 (MIT).
import type { Decide, Decision } from "../lib/client.ts";
import { expandPatterns, parallel, pruneFiles, readFileState } from "../lib/files.ts";
import { parseQuestions } from "../lib/questions.ts";

export async function askFiles(patterns: string[], json: string, cwd: string, decide: Decide, recursive = false, signal?: AbortSignal) {
  const questions = parseQuestions(json);
  const { files, skipped } = await pruneFiles(await expandPatterns(patterns, cwd, recursive), cwd);
  const results: ({ path: string } & Pick<Decision, "answers" | "usage">)[] = [];
  let attempts = 0;
  await parallel(files, 16, async (path) => {
    signal?.throwIfAborted();
    try {
      const state = await readFileState(path, cwd);
      attempts++;
      const { answers, usage } = await decide(state, questions);
      results.push({ path, answers, usage });
    } catch (error) {
      signal?.throwIfAborted();
      skipped.push({ path, reason: error instanceof Error ? error.message : "call failed" });
    }
  });
  results.sort((a, b) => a.path.localeCompare(b.path));
  skipped.sort((a, b) => a.path.localeCompare(b.path));
  return { results, skipped, calls: results.length, attempts };
}
