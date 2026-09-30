import { expect, test } from "bun:test";
import type { Answer, Questions } from "../extensions/jev/lib/types.ts";
import { formatCall, formatResult, formatQuestion, formatPath, formatNoul, type DisplayArgs, type DisplayDetails, type Line, type ToolName } from "../extensions/jev/ui/format.ts";
import { initTheme, ToolExecutionComponent, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import jevTools from "../extensions/jev/index.ts";

const stripAnsi = (text: string) => Bun.stripANSI(text);
const text = (rows: Line[]) => rows.map((row) => row.text).join("\n");
const noul: Answer = { type: "noul", noul: 0.72 };
const choice: Answer = { type: "choice", choice: "security", confidence: 0.54, probabilities: { security: 0.8, other: 0.2 } };
const score: Answer = { type: "score", score: 1.94, confidence: 0.9, probabilities: { "0": 0, "1": 0.06, "2": 0.94 }, legend: { "0": "Simple", "1": "Moderate", "2": "Complex / likely bug" } };
const questions: Questions = {
  suspect: { type: "noul", instructions: "Could this handling broaden a pathspec?" },
  category: { type: "choice", instructions: "Which category?", criteria: { security: "Security boundary", other: "Other" } },
  position: { type: "score", instructions: "How risky?", criteria: ["Simple", "Moderate", "Complex / likely bug"] },
};
const args = { questions_json: JSON.stringify(questions) };
const answers = { suspect: noul, category: choice, position: score };
const forbidden = ["input_tokens", "output_tokens", "state_summary", "probabilities", "legend", "questions_json", '"answers":', '"usage":'];
function clean(output: string) { for (const fragment of forbidden) expect(output).not.toContain(fragment); }

test("noul displays confidence in the displayed answer, including ties", () => {
  expect(formatNoul(0.72)).toBe("Yes · 72%");
  expect(formatNoul(0.24)).toBe("No · 76%");
  expect(formatNoul(0.5)).toBe("No · 50%");
  const output = text(formatResult("ask_jev_file_bool", {}, { noul: 0.24 }));
  expect(output).not.toContain("No · 24%");
  clean(output);
});
test("single tools show question, path, answer and validated confidence only", () => {
  for (const [name, input, details, expected] of [
    ["ask_jev_file_bool", {}, { noul: 0.72 }, "Yes · 72%"],
    ["ask_jev_file_choice", { options: { security: "Security boundary" } }, { choice: "security", confidence: 0.54 }, "Security boundary · 54%"],
    ["ask_jev_file_score", { levels: ["Simple", "Moderate", "Complex / likely bug"] }, { score: 1.94, nearest: "Complex / likely bug", confidence: 0.9 }, "Complex / likely bug · 90%"],
  ] as const) {
    const callArgs = { ...input, path: "extensions/jev/lib/command.ts", question: "What does this do?" };
    const output = text([...formatCall(name, callArgs), ...formatResult(name, callArgs, details)]);
    expect(output).toContain("ask_jev · extensions/jev/lib/command.ts");
    expect(output).toContain("What does this do?");
    expect(output).toContain(expected);
    clean(output);
  }
});
test("general multiple questions use actual instructions, never escaped JSON", () => {
  for (const expanded of [false, true]) {
    const output = text(formatResult("ask_jev", args, { answers }, { expanded }));
    for (const phrase of ["Could this handling broaden a pathspec?", "Yes · 72%", "Security boundary · 54%", "Complex / likely bug · 90%"]) expect(output).toContain(phrase);
    clean(output);
  }
  expect(formatQuestion({ question: "Structured question", largeData: { secret: "not displayed" } })).toBe("Structured question");
  expect(formatQuestion({ irrelevant: { huge: "object" } }, "risk_bucket")).toBe("risk bucket");
  expect(() => formatResult("ask_jev", { questions_json: "{" }, { answers })).not.toThrow();
});
test("batch questions appear once; normal rows are bounded and expanded rows stay human", () => {
  const results = Array.from({ length: 18 }, (_, i) => ({ path: `src/module-${i}.ts`, answers }));
  const details = { results, calls: 18, attempts: 18, skipped: [] };
  const normal = text(formatResult("ask_jev_files", args, details));
  expect(normal).toContain("18 files judged");
  expect(normal).toContain("12 more results");
  expect(normal).not.toContain("module-17.ts");
  expect(normal.split("Which category?")).toHaveLength(2);
  const expanded = text(formatResult("ask_jev_files", args, details, { expanded: true }));
  expect(expanded).toContain("module-17.ts");
  expect(expanded).not.toContain("more results");
  clean(normal); clean(expanded);
});
test("pick renders candidate or none without distributions", () => {
  for (const [path, confidence, expected] of [["src/a.ts", 0.81, "src/a.ts · 81%"], [null, 0.68, "No candidate · 68%"]] as const) {
    const output = text([...formatCall("pick_first_file", { question: "Which file first?" }), ...formatResult("pick_first_file", {}, { path, confidence })]);
    expect(output).toContain("Which file first?"); expect(output).toContain(expected); clean(output);
  }
});
test("partial/complete failures and meaningful omissions stay visible; expected skips are quiet", () => {
  const details: DisplayDetails = {
    results: [{ path: "src/a.ts", answers }], calls: 1, attempts: 2,
    skipped: [{ path: "src/b.ts", reason: "Jev typesafe HTTP 500." }, { path: "image.png", reason: "binary or lock file: image.png" }],
  };
  for (const expanded of [false, true]) {
    const output = text(formatResult("ask_jev_files", args, details, { expanded }));
    expect(output).toContain("1 file judged"); expect(output).toContain("1 failed: Jev typesafe HTTP 500.");
    expect(output).not.toContain("image.png"); clean(output);
  }
  const complete = text(formatResult("ask_jev_files", args, { ...details, results: [], calls: 0 }, { isError: true }));
  expect(complete).toContain("0 files judged"); expect(complete).toContain("2 failed");
  const error = text(formatResult("ask_jev", args, undefined, { isError: true, errorText: "Jev is not configured." }));
  expect(error).toContain("Jev is not configured."); clean(error);
  expect(text(formatResult("ask_jev", args, undefined, { isPartial: true }))).toBe("Judging…");
  const omitted = text(formatResult("ask_jev", args, { answers, state_summary: { skipped: [{ path: "missing.ts", reason: "not found: missing.ts" }] } }));
  expect(omitted).toContain("1 input omitted");
  const mixed = text(formatResult("ask_jev_files", args, { ...details, skipped: [...details.skipped!, { path: "extra.ts", reason: "over the 255 file cap; narrow the pattern" }] }));
  expect(mixed).toContain("1 failed; 1 input omitted");
});
test("long questions/paths are bounded and terminal control characters are removed", () => {
  expect(formatQuestion("long ".repeat(1000)).length).toBeLessThanOrEqual(180);
  const path = `${"long-directory/".repeat(100)}important-file.ts`;
  expect(formatPath(path).length).toBeLessThanOrEqual(80);
  expect(formatPath(path)).toEndWith("important-file.ts");
  const output = text(formatCall("ask_jev_file_bool", { path, question: "Hello\u001b[31m\nworld\u0007" }));
  expect(output.replaceAll("\n", "")).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
});

const renderExamples: { name: ToolName; args: DisplayArgs; details: DisplayDetails }[] = [
  { name: "ask_jev", args, details: { answers } },
  { name: "ask_jev_files", args, details: { results: [{ path: "src/a.ts", answers }], calls: 1, attempts: 1, skipped: [] } },
  { name: "pick_first_file", args: { question: "Which file first?" }, details: { path: "src/a.ts", confidence: 0.81 } },
  { name: "ask_jev_file_bool", args: { path: "src/a.ts", question: "Relevant?" }, details: { noul: 0.24 } },
  { name: "ask_jev_file_choice", args: { path: "src/a.ts", question: "Category?", options: { security: "Security boundary" } }, details: { choice: "security", confidence: 0.54 } },
  { name: "ask_jev_file_score", args: { path: "src/a.ts", question: "Position?", levels: ["Simple", "Moderate", "Complex / likely bug"] }, details: { score: 1.94, nearest: "Complex / likely bug", confidence: 0.9 } },
  { name: "ask_jev_file_bool", args: { path: "src/界面/文件.ts", question: "Is this relevant? 界面 🔍 ".repeat(30) }, details: { noul: 0.72 } },
];

test("Pi's actual ToolExecutionComponent uses registered hooks in compact and expanded modes", () => {
  initTheme("dark");
  const tools: ToolDefinition[] = [];
  jevTools({ registerTool: (tool: ToolDefinition) => tools.push(tool), on: () => () => {} } as unknown as ExtensionAPI);
  for (const example of renderExamples) {
    const definition = tools.find((tool) => tool.name === example.name)!;
    expect(definition.renderCall).toBeFunction(); expect(definition.renderResult).toBeFunction();
    const row = new ToolExecutionComponent(example.name, "render-test", example.args, {}, definition, { requestRender() {} } as TUI, process.cwd());
    row.markExecutionStarted(); row.setArgsComplete();
    const result = { content: [{ type: "text", text: JSON.stringify({ ...example.details, usage: { input_tokens: 20, output_tokens: 5 } }) }], details: example.details, isError: false };
    const snapshot = JSON.stringify(result);
    row.updateResult(result);
    for (const expanded of [false, true]) {
      row.setExpanded(expanded);
      for (const width of [24, 80, 140]) {
        const lines = row.render(width);
        expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
        const output = lines.map(stripAnsi).join("\n");
        clean(output);
        expect(output).not.toContain("\\\"suspect\\\"");
      }
    }
    expect(JSON.stringify(result)).toBe(snapshot);
    row.updateResult({ content: [{ type: "text", text: "Jev typesafe HTTP 401. Check TYPESAFE_API_KEY." }], details: undefined, isError: true });
    const error = row.render(140).map(stripAnsi).join("\n");
    expect(error).toContain("HTTP 401"); clean(error);
  }
});
