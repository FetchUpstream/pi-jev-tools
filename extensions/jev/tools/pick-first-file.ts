// Candidate selection adapted from Ten Levels of Jev, level 9 (MIT).
import type { Decide } from "../lib/client.ts";
import { LIMITS } from "../lib/types.ts";

export interface Candidate { path: string; note?: string }
export async function pickFirstFile(question: string, candidates: Candidate[], decide: Decide) {
  if (!candidates.length) return { path: null, confidence: 0, probabilities: {} };
  if (candidates.some((c) => c.path === "none")) throw new Error('Candidate path "none" is reserved for the exit option.');
  const selected = [...new Map(candidates.map((c) => [c.path, c])).values()];
  if (selected.length >= LIMITS.MAX_CHOICE_OPTIONS) throw new Error(`pick_first_file has ${selected.length} unique candidates; maximum 254. Narrow the candidate list; no unique candidates were omitted.`);
  const criteria = Object.fromEntries([...selected.map((c) => [c.path, c.note ?? null]), ["none", "No file in the list fits"]]);
  const { answers } = await decide({ question, files: selected.map((c) => c.path) }, {
    pick: { type: "choice", instructions: question, criteria },
  });
  const a = answers.pick;
  if (a.type !== "choice") throw new Error("Expected a choice answer.");
  return { path: a.choice === "none" || a.confidence < 0.3 ? null : a.choice, confidence: a.confidence, probabilities: a.probabilities };
}
