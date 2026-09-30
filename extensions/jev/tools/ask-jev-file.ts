// Single-file tools adapted from Ten Levels of Jev, level 8 (MIT).
import type { Decide } from "../lib/client.ts";
import { readFileState } from "../lib/files.ts";
import { validateQuestions, type Questions } from "../lib/types.ts";

async function ask(path: string, cwd: string, questions: Questions, decide: Decide) {
  validateQuestions(questions);
  return decide(await readFileState(path, cwd), questions);
}

export async function askFileBool(path: string, question: string, cwd: string, criteria: { yes?: string; no?: string }, decide: Decide) {
  const { answers, usage } = await ask(path, cwd, {
    answer: { type: "noul", instructions: question, criteria: { true: criteria.yes, false: criteria.no } },
  }, decide);
  const a = answers.answer;
  if (a.type !== "noul") throw new Error("Expected a noul answer.");
  return { path, answer: a.noul > 0.5, noul: a.noul, usage };
}

export async function askFileChoice(path: string, question: string, options: Record<string, string>, cwd: string, decide: Decide) {
  const criteria = { ...options };
  if (!["other", "none", "none_of_the_above"].some((key) => Object.hasOwn(criteria, key))) criteria.other = "None of the above";
  const { answers, usage } = await ask(path, cwd, { answer: { type: "choice", instructions: question, criteria } }, decide);
  const a = answers.answer;
  if (a.type !== "choice") throw new Error("Expected a choice answer.");
  return { path, choice: a.choice, confidence: a.confidence, probabilities: a.probabilities, usage };
}

export async function askFileScore(path: string, question: string, levels: string[], cwd: string, decide: Decide) {
  const { answers, usage } = await ask(path, cwd, { answer: { type: "score", instructions: question, criteria: levels } }, decide);
  const a = answers.answer;
  if (a.type !== "score") throw new Error("Expected a score answer.");
  return { path, score: a.score, top: levels.length - 1, nearest: a.legend[String(Math.round(a.score))], confidence: a.confidence, legend: a.legend, usage };
}
