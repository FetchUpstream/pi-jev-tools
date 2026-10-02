import { validateQuestions, type Answer, type Questions } from "../lib/types.ts";
import { skipReason, type Skipped, type SkipCounts } from "../lib/files.ts";

export type ToolName = "ask_jev" | "ask_jev_files" | "pick_first_file" | "ask_jev_file_bool" | "ask_jev_file_choice" | "ask_jev_file_score";
export type Tone = "title" | "question" | "answer" | "muted" | "warning" | "error";
export interface Line { text: string; tone: Tone }
export interface DisplayArgs {
  path?: string;
  question?: string;
  questions_json?: string;
  options?: Record<string, string>;
  levels?: readonly string[];
  paths?: readonly string[];
}
interface DisplaySkips extends Partial<SkipCounts> { skipped?: Skipped[] }
export interface DisplayDetails extends DisplaySkips {
  path?: string | null;
  noul?: number;
  choice?: string;
  score?: number;
  nearest?: string;
  confidence?: number;
  answers?: Record<string, Answer>;
  results?: { path: string; answers: Record<string, Answer> }[];
  calls?: number;
  attempts?: number;
  state_summary?: DisplaySkips;
}

// User/provider text must never inject terminal controls into themed output.
export function compactText(value: string, limit = 180): string {
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}
export function formatPath(path: string, limit = 80): string {
  const text = compactText(path, Number.MAX_SAFE_INTEGER);
  if (text.length <= limit) return text;
  const tail = Math.floor((limit - 1) * 0.7);
  return `${text.slice(0, limit - tail - 1)}…${text.slice(-tail)}`;
}
export function formatConfidence(value: number): string {
  return `${Math.round(value * 100)}%`;
}
/** Extract a short human label, never dump structured JSON into the terminal. */
export function formatQuestion(instructions: unknown, fallback = "Judgment", limit = 180): string {
  function label(value: unknown, depth: number): string | undefined {
    if (typeof value === "string" && value.trim()) return value;
    if (depth > 8 || !value || typeof value !== "object") return undefined;
    if (Array.isArray(value)) return value.map((entry) => label(entry, depth + 1)).filter(Boolean).join(" · ") || undefined;
    for (const key of ["question", "label", "description", "prompt", "instructions", "task", "text"]) {
      if (key in value) {
        const found = label(Reflect.get(value, key), depth + 1);
        if (found) return found;
      }
    }
    return undefined;
  }
  return compactText(label(instructions, 0) ?? fallback.replace(/[_-]/g, " "), limit);
}
export function formatNoul(noul: number): string {
  // Displayed-answer probability, not Choice/Score confidence.
  return `${noul > 0.5 ? "Yes" : "No"} · ${Math.round(Math.max(noul, 1 - noul) * 100)}%`;
}
export function formatChoice(choice: string, confidence: number, criteria?: Record<string, unknown>): string {
  return `${formatQuestion(criteria?.[choice], choice, 100)} · ${formatConfidence(confidence)}`;
}
export function formatScore(label: unknown, confidence: number): string {
  return `${formatQuestion(label, "Score", 100)} · ${formatConfidence(confidence)}`;
}

function questionsOf(args: DisplayArgs): Questions {
  try {
    const parsed: unknown = JSON.parse(args.questions_json ?? "{}");
    validateQuestions(parsed);
    return parsed;
  } catch { return {}; } // Incomplete streaming arguments are normal.
}
function formatAnswer(answer: Answer, question?: Questions[string]): string {
  switch (answer.type) {
    case "noul": return formatNoul(answer.noul);
    case "choice": return formatChoice(answer.choice, answer.confidence, question?.type === "choice" ? question.criteria : undefined);
    case "score": return formatScore(answer.legend[String(Math.round(answer.score))] ?? "Score", answer.confidence);
  }
}
const line = (text: string, tone: Tone = "answer"): Line => ({ text, tone });
const EXPECTED_SKIP = /^(?:binary(?: or lock file)?|empty|skipped directory|not a file)(?::|$)/;
function omissionLines(details: DisplaySkips, expanded: boolean, failed = 0): Line[] {
  const meaningful = (details.skipped ?? []).filter((skip) => !EXPECTED_SKIP.test(skip.reason));
  // Old session results have only examples; new results carry exact aggregate counts.
  const counts = Object.entries(details.skipped_by_reason ?? {}).filter(([reason]) => !EXPECTED_SKIP.test(reason));
  const meaningfulTotal = details.skipped_by_reason
    ? counts.reduce((total, [, count]) => total + count, 0)
    : meaningful.length;
  if (!meaningfulTotal && !failed) return [];
  const sampledReasons = new Set(meaningful.map((skip) => skipReason(skip.reason)));
  const unsampled = counts.filter(([reason]) => !sampledReasons.has(reason));
  const reasons = [...new Set([...meaningful.map((skip) => skip.reason), ...unsampled.map(([reason]) => reason)].map((reason) => compactText(reason, 140)))];
  const omitted = Math.max(0, meaningfulTotal - failed);
  const omission = `${omitted} ${omitted === 1 ? "input" : "inputs"} omitted`;
  const summary = failed ? `${failed} failed${omitted ? `; ${omission}` : ""}` : omission;
  const rows = [line(`${summary}${reasons.length ? `: ${reasons[0]}` : ""}`, "warning")];
  if (expanded) {
    rows.push(...meaningful.map((skip) => line(`${formatPath(skip.path)} · ${compactText(skip.reason, 240)}`, "warning")));
    rows.push(...unsampled.map(([reason, count]) => line(`${count} · ${compactText(reason, 240)}`, "warning")));
  } else if (reasons.length > 1) {
    rows.push(line(`${reasons.length - 1} more omission reasons (expand to inspect)`, "warning"));
  }
  if (meaningfulTotal > meaningful.length) rows.push(line(`${meaningful.length} of ${meaningfulTotal} diagnostic examples retained`, "muted"));
  return rows;
}

export function formatCall(name: ToolName, args: DisplayArgs): Line[] {
  const fileTool = name.startsWith("ask_jev_file_");
  const title = fileTool ? "ask_jev" : name;
  const path = args.path ?? (args.paths?.length === 1 ? args.paths[0] : undefined);
  const rows = [line(`${title}${path ? ` · ${formatPath(path)}` : ""}`, "title")];
  if (args.question) rows.push(line(formatQuestion(args.question), "question"));
  return rows;
}

export function formatBatchResult(args: DisplayArgs, details: DisplayDetails, expanded = false): Line[] {
  const results = details.results ?? [];
  const questions = Object.entries(questionsOf(args));
  const shown = expanded ? results : results.slice(0, 6);
  const count = details.calls ?? results.length;
  const rows = [line(`${count} ${count === 1 ? "file" : "files"} judged`, "muted")];
  for (const [id, question] of expanded ? questions : questions.slice(0, 4)) {
    rows.push(line(formatQuestion(question?.instructions, id, expanded ? 500 : 180), "question"));
    for (const result of shown) {
      const answer = result.answers[id];
      rows.push(line(`${formatPath(result.path)} · ${answer ? formatAnswer(answer, question) : "No answer"}`));
    }
  }
  if (!expanded && results.length > shown.length) rows.push(line(`${results.length - shown.length} more results (expand to inspect)`, "muted"));
  if (!expanded && questions.length > 4) rows.push(line(`${questions.length - 4} more questions (expand to inspect)`, "muted"));
  rows.push(...omissionLines(details, expanded, Math.max(0, (details.attempts ?? results.length) - (details.calls ?? results.length))));
  if (!results.length && !rows.some((row) => row.tone === "warning")) rows.push(line("No files available to judge", "warning"));
  return rows;
}

export function formatResult(name: ToolName, args: DisplayArgs, details: DisplayDetails | undefined, options: { expanded?: boolean; isPartial?: boolean; isError?: boolean; errorText?: string } = {}): Line[] {
  const expanded = options.expanded ?? false;
  if (!details) {
    if (options.isError) return [line(compactText(options.errorText ?? "Jev request failed", expanded ? 1000 : 300), "error")];
    return [line(options.isPartial ? "Judging…" : "No judgment available", "muted")];
  }
  if (name === "ask_jev_files") return formatBatchResult(args, details, expanded);
  if (name === "ask_jev") {
    const questions = questionsOf(args);
    const answers = Object.entries(details.answers ?? {});
    const rows: Line[] = [];
    for (const [id, answer] of expanded ? answers : answers.slice(0, 4)) {
      rows.push(line(formatQuestion(questions[id]?.instructions, id, expanded ? 500 : 180), "question"), line(formatAnswer(answer, questions[id])));
    }
    if (!expanded && answers.length > 4) rows.push(line(`${answers.length - 4} more questions (expand to inspect)`, "muted"));
    rows.push(...omissionLines(details.state_summary ?? {}, expanded));
    return rows;
  }
  if (name === "pick_first_file") return [line(`${details.path ? formatPath(details.path) : "No candidate"} · ${formatConfidence(details.confidence ?? 0)}`)];
  if (name === "ask_jev_file_bool") return [line(formatNoul(details.noul ?? 0.5))];
  if (name === "ask_jev_file_choice") return [line(formatChoice(details.choice ?? "No choice", details.confidence ?? 0, args.options))];
  return [line(formatScore(details.nearest ?? args.levels?.[Math.round(details.score ?? 0)] ?? "Score", details.confidence ?? 0))];
}
