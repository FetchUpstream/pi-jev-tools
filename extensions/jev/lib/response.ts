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
    if (q.type === "choice") {
      const choice = answer.choice;
      if (typeof choice !== "string" || !keys.includes(choice)) {
        throw new ContractError(`Undeclared choice returned: ${id}`);
      }
      if (keys.some((k) => (probs[k] as number) > (probs[choice] as number))) {
        throw new ContractError(`Choice must have maximum probability: ${id}`);
      }
    }
    if (q.type === "score") {
      if (!isNonnegative(answer.score) || answer.score > keys.length - 1) {
        throw new ContractError(`Score out of range: ${id}`);
      }
      // Score and legend are redundant; validate their wire shape, not equality.
      // Canonical values come from the validated distribution and original rubric.
      const legend = answer.legend;
      if (!isObject(legend) || Object.keys(legend).length !== keys.length ||
        !keys.every((k) => Object.hasOwn(legend, k) && typeof legend[k] === "string")) {
        throw new ContractError(`Score legend must contain the declared level keys and string descriptions: ${id}`);
      }
    }
  }
}

/** Only known typed values reach Pi, never provider extensions or raw exchanges. */
function compactAnswer(a: Answer, q: Questions[string]): Answer {
  switch (a.type) {
    case "noul": return { type: a.type, noul: a.noul };
    case "choice": return { type: a.type, choice: a.choice, confidence: a.confidence, probabilities: a.probabilities };
    case "score": {
      if (q.type !== "score") throw new ContractError("Mismatched score rubric.");
      const keys = q.criteria.map((_, i) => String(i));
      const sum = keys.reduce((total, key) => total + a.probabilities[key], 0);
      const weighted = keys.reduce((total, key, i) => total + i * a.probabilities[key], 0) / sum;
      // A validated mean cannot exceed the top level except by floating-point error.
      const score = Math.min(keys.length - 1, weighted);
      return {
        type: a.type, score, confidence: a.confidence, probabilities: a.probabilities,
        legend: Object.fromEntries(q.criteria.map((level, i) => [String(i), level])),
      };
    }
  }
}

export function compactResponse(response: SystemOneResponse, questions: Questions) {
  const answers = Object.fromEntries(Object.keys(questions).map((id) => [id, compactAnswer(response.answers[id], questions[id])]));
  const { input_tokens, output_tokens, cost } = response.usage;
  return {
    answers, model: response.model,
    usage: { input_tokens, output_tokens, ...(isNonnegative(cost) ? { cost } : {}) },
  };
}
