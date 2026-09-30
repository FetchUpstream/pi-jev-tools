// State and question parsing adapted from Ten Levels of Jev (MIT).
import { validateQuestions, type Questions, type State } from "./types.ts";

export function parseQuestions(json: string): Questions {
  let parsed: unknown;
  try { parsed = JSON.parse(json); }
  catch { throw new Error("questions_json is not valid JSON. Pass an object keyed by question id."); }
  validateQuestions(parsed);
  for (const [id, question] of Object.entries(parsed)) {
    if (!id.trim()) throw new Error("Question ids must be nonblank.");
    if (Object.keys(question).some((key) => !["type", "instructions", "criteria"].includes(key))) {
      throw new Error(`Question "${id}" has unknown fields; use type, instructions and criteria.`);
    }
  }
  return parsed;
}

/** JSON objects/arrays preserve their structure; other text remains plain text. */
export function parseState(raw: string | Record<string, unknown>): State {
  if (typeof raw !== "string") return raw;
  const trimmed = raw.trim();
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    try { return JSON.parse(trimmed); } catch { /* Treat malformed JSON as text, as upstream does. */ }
  }
  return raw;
}

export const QUESTION_DESCRIPTION =
  'questions_json is an object keyed by id: noul {"type":"noul","instructions":"Is ...?","criteria":{"true":"yes case","false":"no case"}}; ' +
  'choice {"type":"choice","instructions":"Which ...?","criteria":{"a":"when a","other":"none fit"}} (1–255 keys); ' +
  'score {"type":"score","instructions":"How risky ...?","criteria":["isolated/tested","security sensitive"]} (2–10 ordered situations). ' +
  "Ask all needed questions in one block. Answers are probabilities, declared choices or weighted scores, never prose.";
