// Batch judgments adapted from Ten Levels of Jev, level 9 (MIT).
import type { Decide, Decision } from "../lib/client.ts";
import { expandPatterns, parallel, pruneFiles, readFileState, retainSkip } from "../lib/files.ts";
import { parseQuestions } from "../lib/questions.ts";

export async function askFiles(patterns: string[], json: string, cwd: string, decide: Decide, recursive = false, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const questions = parseQuestions(json);
  const expanded = await expandPatterns(patterns, cwd, recursive, signal);
  signal?.throwIfAborted();
  const { files, ...metadata } = await pruneFiles(expanded, cwd, undefined, signal);
  signal?.throwIfAborted();
  const results: ({ path: string } & Pick<Decision, "answers" | "usage">)[] = [];
  let attempts = 0;
  await parallel(files, 16, async (path) => {
    signal?.throwIfAborted();
    try {
      const state = await readFileState(path, cwd, signal);
      signal?.throwIfAborted();
      attempts++;
      const { answers, usage } = await decide(state, questions);
      signal?.throwIfAborted();
      results.push({ path, answers, usage });
    } catch (error) {
      signal?.throwIfAborted();
      retainSkip(metadata, { path, reason: error instanceof Error ? error.message : "call failed" });
    }
  }, signal);
  signal?.throwIfAborted();
  results.sort((a, b) => a.path.localeCompare(b.path));
  metadata.skipped.sort((a, b) => a.path.localeCompare(b.path));
  return { results, ...metadata, calls: results.length, attempts };
}
