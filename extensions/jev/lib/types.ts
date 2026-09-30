/**
 * TypeSafe System One API types — the exact wire contract for Jev.
 *
 * One endpoint: POST https://api.typesafe.ai/v1/systemone
 * You send a `state` and a map of typed `questions`; you get back one typed
 * `answer` per question, keyed by the IDs you chose.
 */

/** SDK JsonValue: scalar leaves may appear inside structured content. */
export type JsonContent = string | number | boolean | null | JsonContent[] | { [key: string]: JsonContent };
/** SDK EntryType: top-level numbers/booleans are not entries. */
export type EntryContent = string | { [key: string]: JsonContent } | JsonContent[] | null;
export type StructuredContent = Exclude<EntryContent, null>;
export type State = StructuredContent;
export type Instructions = EntryContent;
export interface NoulCriteria { true?: EntryContent; false?: EntryContent }
export type ChoiceCriteria = Record<string, EntryContent>;
/** Length is enforced at the transport boundary. */
export type ScoreCriteria = StructuredContent[];
export interface NoulQuestion {
  type: "noul";
  instructions?: Instructions;
  criteria?: NoulCriteria | null;
}
export interface ChoiceQuestion {
  type: "choice";
  instructions?: Instructions;
  criteria: ChoiceCriteria;
}
export interface ScoreQuestion {
  type: "score";
  instructions?: Instructions;
  criteria: ScoreCriteria;
}

export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;

/** Question IDs are for your code. They are not sent to the model and are not used in inference. */
export type Questions = Record<string, Question>;

export interface NoulAnswer {
  type: "noul";
  /** The probability the answer is yes. 0 = strong no, 1 = strong yes, 0.5 = uncertain. */
  noul: number;
}

export interface ChoiceAnswer {
  type: "choice";
  /** The highest-probability option. Always one you defined. */
  choice: string;
  /** Every option mapped to its probability. Floats that sum to 1. */
  probabilities: Record<string, number>;
  /** How certain the model is, derived from the shape of the distribution. */
  confidence: number;
}

export interface ScoreAnswer {
  type: "score";
  /** Probability-weighted position along the levels. Can land between levels. */
  score: number;
  /** Each level number mapped back to its description. */
  legend: Record<string, StructuredContent>;
  /** Each level mapped to its probability. Floats that sum to 1. */
  probabilities: Record<string, number>;
  confidence: number;
}

export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface SystemOneRequest {
  /** Defaults to "jev-latest". */
  model?: string;
  state: State;
  questions: Questions;
}

export interface SystemOneUsage {
  input_tokens: number;
  output_tokens: number;
  /** Provider-reported USD cost. Only finite, nonnegative numbers are trusted. */
  cost?: unknown;
  [key: string]: unknown;
}

export interface SystemOneResponse {
  /** The versioned model that answered. Log it. */
  model: string;
  answers: Record<string, Answer>;
  usage: SystemOneUsage;
  /** Provider extensions are retained, not stripped during validation. */
  [key: string]: unknown;
}

/** Client-side validation limits, mirrored from the published API. */
export const LIMITS = {
  MAX_CHOICE_OPTIONS: 255,
  MIN_SCORE_LEVELS: 1, // Wire OpenAPI; convenience helper still recommends at least two.
  MAX_SCORE_LEVELS: 10,
  /** Approximate shared token budget for state + all questions. */
  TOTAL_TOKEN_BUDGET: 64_000,
  PER_QUESTION_TOKEN_BUDGET: 32_000,
} as const;

export class QuestionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuestionValidationError";
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

/** Reject non-JSON values, nonfinite numbers, sparse arrays and cycles before stringify. */
export function isJsonContent(value: unknown, ancestors = new Set<unknown>()): value is JsonContent {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (!Array.isArray(value) && !isRecord(value)) return false;
  if (ancestors.has(value)) return false;
  ancestors.add(value);
  const valid = Array.isArray(value)
    ? Array.from({ length: value.length }, (_, i) => Object.hasOwn(value, i) && isJsonContent(value[i], ancestors)).every(Boolean)
    : Object.values(value).every((entry) => isJsonContent(entry, ancestors));
  ancestors.delete(value);
  return valid;
}
export function isEntryContent(value: unknown): value is EntryContent {
  return (value === null || typeof value === "string" || Array.isArray(value) || isRecord(value)) && isJsonContent(value);
}
/** Validate runtime input as well as TypeScript callers, before any transport. */
export function validateRequest(request: unknown): asserts request is SystemOneRequest {
  if (!isRecord(request)) throw new QuestionValidationError("Expected a request object.");
  if (request.state === null || !isEntryContent(request.state)) {
    throw new QuestionValidationError("State must be JSON-serializable string, object, or array (no cycles, undefined, or nonfinite numbers).");
  }
  if (request.model !== undefined && (typeof request.model !== "string" || !request.model.trim())) {
    throw new QuestionValidationError("Model must be a nonblank string.");
  }
  validateQuestions(request.questions);
}

/** Validate a request's question shapes before it is ever sent. */
export function validateQuestions(questions: unknown): asserts questions is Questions {
  if (!isRecord(questions) || Object.keys(questions).length === 0) {
    throw new QuestionValidationError("Questions must be a nonempty object.");
  }
  for (const [id, q] of Object.entries(questions)) {
    if (!isRecord(q)) throw new QuestionValidationError(`Question "${id}" must be an object.`);
    if (q.type !== "noul" && q.type !== "choice" && q.type !== "score") {
      throw new QuestionValidationError(`Question "${id}" has a missing or unknown type.`);
    }
    if (q.instructions !== undefined && !isEntryContent(q.instructions)) {
      throw new QuestionValidationError(`Question "${id}" instructions must be JSON string, object, array, or null.`);
    }
    if (q.type === "noul" && q.criteria !== undefined && q.criteria !== null) {
      if (!isRecord(q.criteria) || Object.entries(q.criteria).some(
        ([key, value]) => !["true", "false"].includes(key) || !isEntryContent(value)
      )) {
        throw new QuestionValidationError(`Noul "${id}" criteria must map true/false to descriptions.`);
      }
    }
    if (q.type === "choice") {
      if (!isRecord(q.criteria)) {
        throw new QuestionValidationError(`Choice "${id}" criteria must be an object.`);
      }
      const options = Object.keys(q.criteria);
      if (options.length === 0) {
        throw new QuestionValidationError(`Choice "${id}" has no options.`);
      }
      if (options.length > LIMITS.MAX_CHOICE_OPTIONS) {
        throw new QuestionValidationError(
          `Choice "${id}" has ${options.length} options; the maximum is ${LIMITS.MAX_CHOICE_OPTIONS}.`
        );
      }
      if (Object.values(q.criteria).some((value) => !isEntryContent(value))) {
        throw new QuestionValidationError(`Choice "${id}" descriptions must be JSON string, object, array, or null.`);
      }
    }
    if (q.type === "score") {
      if (!Array.isArray(q.criteria)) {
        throw new QuestionValidationError(`Score "${id}" criteria must be an array.`);
      }
      if (q.criteria.length < LIMITS.MIN_SCORE_LEVELS || q.criteria.length > LIMITS.MAX_SCORE_LEVELS) {
        throw new QuestionValidationError(
          `Score "${id}" must have between ${LIMITS.MIN_SCORE_LEVELS} and ${LIMITS.MAX_SCORE_LEVELS} levels; got ${q.criteria.length}.`
        );
      }
      if (!isJsonContent(q.criteria) || q.criteria.some((level) => level === null || !isEntryContent(level))) {
        throw new QuestionValidationError(`Score "${id}" levels must be JSON string, object, or array.`);
      }
    }
  }
}
