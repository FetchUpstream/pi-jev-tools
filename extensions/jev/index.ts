// Pi tool contracts adapted from IndyDevDan's Ten Levels of Jev (MIT).
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { JevClient, type Decide } from "./lib/client.ts";
import { readConfig } from "./lib/config.ts";
import { QUESTION_DESCRIPTION } from "./lib/questions.ts";
import { JEV_POLICY_MARKER, JEV_USAGE_POLICY } from "./lib/policy.ts";
import * as S from "./lib/schemas.ts";
import { askJev } from "./tools/ask-jev.ts";
import { askFileBool, askFileChoice, askFileScore } from "./tools/ask-jev-file.ts";
import { askFiles } from "./tools/ask-jev-files.ts";
import { pickFirstFile } from "./tools/pick-first-file.ts";

export const TOOL_NAMES = ["ask_jev", "ask_jev_files", "pick_first_file", "ask_jev_file_bool", "ask_jev_file_choice", "ask_jev_file_score"] as const;
const FILE_HINT = "Code reads the file; you get only a typed judgment. Write the question against `content` (file text) and `path`. Use read for code you need to edit/quote, grep for exact lookups.";
const annotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };

/** Each execution owns its client/usage, including the command gate and all batch calls. */
async function run<T>(signal: AbortSignal | undefined, action: (decide: Decide) => Promise<T>) {
  let input = 0, output = 0, cost = 0;
  const usage = () => ({
    input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output,
    cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
  });
  try {
    signal?.throwIfAborted();
    readConfig(); // One short configuration error, even for a large batch.
    const client = new JevClient();
    const decide: Decide = async (state, questions) => {
      const result = await client.systemOne(state, questions, signal);
      input += result.usage.input_tokens;
      output += result.usage.output_tokens;
      cost += result.usage.cost ?? 0;
      return result;
    };
    const payload = await action(decide);
    const text = JSON.stringify(payload);
    return {
      content: [{ type: "text" as const, text }],
      details: payload, structuredContent: JSON.parse(text), usage: usage(),
    };
  } catch (error) {
    // Keep usage already incurred by a gate or earlier batch calls, even on failure.
    return {
      content: [{ type: "text" as const, text: error instanceof Error ? error.message : "Jev execution failed." }],
      details: undefined, isError: true, usage: usage(),
    };
  }
}

export default function jevTools(pi: ExtensionAPI) {
  pi.on("before_agent_start", (event) => {
    if (event.systemPrompt.includes(JEV_POLICY_MARKER)) return;
    return { systemPrompt: event.systemPrompt ? `${event.systemPrompt}\n\n${JEV_USAGE_POLICY}` : JEV_USAGE_POLICY };
  });

  pi.registerTool(defineTool({
    name: "ask_jev", label: "Ask Jev", annotations,
    promptSnippet: "Delegate bounded typed judgments without loading files/output into your context.",
    description: "Primary Jev judgment tool: one situation, one typed question block. state is a short note or JSON string; paths become files[\"path\"]; command becomes output {command,exit_code,stdout,stderr}. Up to 20 files/~60k state tokens; oversized situations include split guidance. Commands are limited to read-only git status/diff/log/show/ls-files, with no shell syntax, and must pass a Jev safety gate. For independent per-file judgments use ask_jev_files. Not a chat tool. " + QUESTION_DESCRIPTION,
    parameters: S.GeneralInput, outputSchema: S.GeneralOutput,
    execute: (_id, p, signal, _update, ctx) => run(signal, (decide) => askJev(p, ctx.cwd, decide, signal)),
  }));
  pi.registerTool(defineTool({
    name: "ask_jev_files", label: "Ask Jev about files", annotations,
    description: "Apply the same typed questions separately to files/directories/globs. Drops dependency/VCS/generated folders, empty/binary/lock/oversized files. At most 255 files, 16 requests in flight. Returns results, skipped reasons, successful calls and attempted calls; individual failures do not discard successes. Write questions against `content` and `path`. " + QUESTION_DESCRIPTION,
    parameters: Type.Object({ paths_or_globs: Type.Array(S.Text, { minItems: 1 }), questions_json: S.Text, recursive: Type.Optional(Type.Boolean({ description: "Recurse for directory inputs; default false. Globs control their own recursion." })) }, { additionalProperties: false }),
    outputSchema: S.FilesOutput,
    execute: async (_id, p, signal, _update, ctx) => {
      const result = await run(signal, (decide) => askFiles(p.paths_or_globs, p.questions_json, ctx.cwd, decide, p.recursive, signal));
      if (result.details && result.details.attempts > 0 && result.details.calls === 0) return { ...result, isError: true };
      return result;
    },
  }));
  pi.registerTool(defineTool({
    name: "pick_first_file", label: "Pick first file", annotations,
    description: "Choose which candidate file to open first for a goal, using optional short notes from prior judgments. Does not read or verify files. Up to 254 distinct candidates plus a none exit. Returns path (null for none or confidence <0.3), confidence and probabilities.",
    parameters: Type.Object({ question: S.Text, candidates: Type.Array(Type.Object({ path: S.Text, note: Type.Optional(S.Text) }, { additionalProperties: false })) }, { additionalProperties: false }),
    outputSchema: S.PickOutput,
    execute: (_id, p, signal) => run(signal, (decide) => pickFirstFile(p.question, p.candidates, decide)),
  }));
  pi.registerTool(defineTool({
    name: "ask_jev_file_bool", label: "Ask Jev: file yes/no", annotations,
    description: "Yes/no judgment of one file. Returns path, boolean answer (noul >0.5), and noul (probability of yes, 0–1). " + FILE_HINT,
    parameters: Type.Object({ path: S.Text, question: S.Text, yes: Type.Optional(S.Text), no: Type.Optional(S.Text) }, { additionalProperties: false }),
    outputSchema: S.BoolOutput,
    execute: (_id, p, signal, _update, ctx) => run(signal, (decide) => askFileBool(p.path, p.question, ctx.cwd, p, decide)),
  }));
  pi.registerTool(defineTool({
    name: "ask_jev_file_choice", label: "Ask Jev: file choice", annotations,
    description: "Choose a declared option about one file. Returns path, choice, confidence and probabilities. Adds other if no other/none/none_of_the_above exit is provided; at most 255 options including that exit. " + FILE_HINT,
    parameters: Type.Object({ path: S.Text, question: S.Text, options: Type.Record(S.Text, S.Text, { minProperties: 1, maxProperties: 255, additionalProperties: false }) }, { additionalProperties: false }),
    outputSchema: S.ChoiceOutput,
    execute: (_id, p, signal, _update, ctx) => run(signal, (decide) => askFileChoice(p.path, p.question, p.options, ctx.cwd, decide)),
  }));
  pi.registerTool(defineTool({
    name: "ask_jev_file_score", label: "Ask Jev: file score", annotations,
    description: "Score a file on 2–10 described situations ordered low to high. Returns path, weighted score (0 to levels.length-1), top, nearest description, confidence and legend. " + FILE_HINT,
    parameters: Type.Object({ path: S.Text, question: S.Text, levels: Type.Array(S.Text, { minItems: 2, maxItems: 10 }) }, { additionalProperties: false }),
    outputSchema: S.ScoreOutput,
    execute: (_id, p, signal, _update, ctx) => run(signal, (decide) => askFileScore(p.path, p.question, p.levels, ctx.cwd, decide)),
  }));
}
