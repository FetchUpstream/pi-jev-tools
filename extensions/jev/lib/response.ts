// Adapted from Ten Levels of Jev; see LICENSE and THIRD_PARTY_NOTICES.md.
import type { Answer, Questions, SystemOneResponse } from "./types.ts";

export class ContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContractError";
  }
}
const isObject = (x: unknown): x is Record<string, unknown> =>
  x !== null && typeof x === "object" && !Array.isArray(x);
const isNonnegative = (x: unknown): x is number =>
  typeof x === "number" && Number.isFinite(x) && x >= 0;
const isUnit = (x: unknown): x is number => isNonnegative(x) && x <= 1;
const isTokenCount = (x: unknown): x is number => isNonnegative(x) && Number.isSafeInteger(x);

/** Strict live contract; unknown payload fields are deliberately retained. */
export function validateResponse(response: unknown, questions: Questions): asserts response is SystemOneResponse {
  if (!isObject(response) || !isObject(response.answers) || typeof response.model !== "string" || !response.model.trim()) {
    throw new ContractError("Invalid response envelope: expected model and answers.");
  }
  if (!isObject(response.usage) || !isTokenCount(response.usage.input_tokens) || !isTokenCount(response.usage.output_tokens)) {
    throw new ContractError("Invalid response usage: expected nonnegative integer input_tokens and output_tokens.");
  }
  for (const [id, q] of Object.entries(questions)) {
    const answer = response.answers[id];
    if (!Object.hasOwn(response.answers, id) || !isObject(answer) || answer.type !== q.type) {
      throw new ContractError(`Missing or mismatched answer: ${id}`);
    }
    if (q.type === "noul") {
      if (!isUnit(answer.noul)) throw new ContractError(`Invalid noul: ${id}`);
      continue;
    }
    if (!isUnit(answer.confidence) || !isObject(answer.probabilities)) {
      throw new ContractError(`Invalid distribution: ${id}`);
    }
    const keys = q.type === "choice" ? Object.keys(q.criteria) : q.criteria.map((_, i) => String(i));
    const probs = answer.probabilities;
    if (Object.keys(probs).length !== keys.length || !keys.every((k) => Object.hasOwn(probs, k) && isUnit(probs[k]))) {
      throw new ContractError(`Distribution keys must match the declared criteria: ${id}`);
    }
    const sum = keys.reduce((acc, k) => acc + (probs[k] as number), 0);
    if (Math.abs(sum - 1) > 0.025) throw new ContractError(`Distribution does not sum to one: ${id} (${sum})`);
    if (q.type === "choice" && (typeof answer.choice !== "string" || !keys.includes(answer.choice))) {
      throw new ContractError(`Undeclared choice returned: ${id}`);
    }
    if (q.type === "score") {
      if (!isNonnegative(answer.score) || answer.score > keys.length - 1) {
        throw new ContractError(`Score out of range: ${id}`);
      }
      const legend = answer.legend;
      if (!isObject(legend) || Object.keys(legend).length !== keys.length ||
        !keys.every((k, i) => Object.hasOwn(legend, k) && legend[k] === q.criteria[i])) {
        throw new ContractError(`Score legend must match the declared criteria: ${id}`);
      }
    }
  }
}

/** Only known typed values reach Pi, never provider extensions or raw exchanges. */
export function compactResponse(response: SystemOneResponse, questions: Questions) {
  const answers: Record<string, Answer> = Object.fromEntries(Object.keys(questions).map((id) => {
    const a = response.answers[id];
    const value: Answer = a.type === "noul" ? { type: a.type, noul: a.noul }
      : a.type === "choice" ? { type: a.type, choice: a.choice, confidence: a.confidence, probabilities: a.probabilities }
      : { type: a.type, score: a.score, confidence: a.confidence, probabilities: a.probabilities, legend: a.legend };
    return [id, value];
  }));
  const { input_tokens, output_tokens, cost } = response.usage;
  return {
    answers, model: response.model,
    usage: { input_tokens, output_tokens, ...(isNonnegative(cost) ? { cost } : {}) },
  };
}
