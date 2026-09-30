import { LIMITS, QuestionValidationError, type SystemOneRequest } from "./types.ts";

/** Approximate only: no first-party tokenizer is exposed. Count serialized framing too. */
export const tokensOf = (text: string): number => Math.ceil(text.length / 4);

export function requestBudget(request: SystemOneRequest) {
  const framing = tokensOf(JSON.stringify({ model: request.model, state: null, questions: {} }));
  const state = tokensOf(JSON.stringify(request.state));
  const individual = Object.entries(request.questions).map(([id, q]) => tokensOf(JSON.stringify({ [id]: q })));
  const all = tokensOf(JSON.stringify(request.questions));
  const longestQuestion = individual.reduce((longest, tokens) => Math.max(longest, tokens), 0);
  return { state, individual, all, framing, total: state + all + framing, longest: state + longestQuestion + framing };
}

export function validateBudget(request: SystemOneRequest): void {
  const budget = requestBudget(request);
  if (budget.total > LIMITS.TOTAL_TOKEN_BUDGET) {
    throw new QuestionValidationError("state + all questions exceeds Jev's total request limit (64k token estimate). Narrow the state or split the questions.");
  }
  if (budget.longest > LIMITS.PER_QUESTION_TOKEN_BUDGET) {
    throw new QuestionValidationError("state + longest question exceeds Jev's per-question context limit (32k token estimate). Narrow the state or question; split unrelated files into separate calls.");
  }
}
