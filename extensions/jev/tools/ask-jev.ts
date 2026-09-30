// General judgment adapted from Ten Levels of Jev, level 10 (MIT).
import { assembleState, type AssembleInput } from "../lib/assemble.ts";
import type { Decide } from "../lib/client.ts";
import { runSafeCommand } from "../lib/command.ts";
import { parseQuestions } from "../lib/questions.ts";

export async function askJev(input: AssembleInput & { questions_json: string }, cwd: string, decide: Decide, signal?: AbortSignal) {
  const questions = parseQuestions(input.questions_json);
  const assembled = await assembleState(input, cwd, (command, directory) => runSafeCommand(command, directory, decide, signal));
  signal?.throwIfAborted();
  const result = await decide(assembled.state, questions);
  return { ...result, state_summary: assembled.summary };
}
