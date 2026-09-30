import { expect, test } from "bun:test";
import type { BeforeAgentStartEvent, BeforeAgentStartEventResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import jevTools from "../extensions/jev/index.ts";
import { JEV_POLICY_MARKER, JEV_USAGE_POLICY } from "../extensions/jev/lib/policy.ts";

type Handler = (event: BeforeAgentStartEvent, ctx: ExtensionContext) => BeforeAgentStartEventResult | void;
function registeredHook(): Handler {
  const handlers: Handler[] = [];
  jevTools({
    registerTool: () => {},
    on: (event: string, handler: Handler) => {
      expect(event).toBe("before_agent_start");
      handlers.push(handler);
      return () => {};
    },
  } as unknown as ExtensionAPI);
  expect(handlers).toHaveLength(1);
  return handlers[0];
}
function invoke(hook: Handler, systemPrompt: string) {
  return hook({ type: "before_agent_start", prompt: "Investigate the repository", systemPrompt } as BeforeAgentStartEvent, {} as ExtensionContext);
}

test("before_agent_start appends the policy to the effective prompt without replacing earlier instructions", () => {
  const hook = registeredHook();
  const original = "Primary instructions\n\nInstructions from an earlier extension.";
  expect(invoke(hook, original)).toEqual({ systemPrompt: `${original}\n\n${JEV_USAGE_POLICY}` });
  expect(invoke(hook, "")).toEqual({ systemPrompt: JEV_USAGE_POLICY });
});
test("policy is supplied on every new turn rather than tracked in global/session state", () => {
  const hook = registeredHook();
  for (const prompt of ["First turn", "Second turn", "First turn", "After reload"]) {
    const result = invoke(hook, prompt);
    expect(result?.systemPrompt).toBe(`${prompt}\n\n${JEV_USAGE_POLICY}`);
  }
});
test("reapplying the hook or an existing marked policy does not duplicate it", () => {
  const hook = registeredHook();
  let effective = "Original instructions";
  for (let turn = 0; turn < 4; turn++) {
    const result = invoke(hook, effective);
    if (result?.systemPrompt) effective = result.systemPrompt;
    expect(effective.split(JEV_POLICY_MARKER)).toHaveLength(2);
  }
  expect(invoke(hook, `Original\n\n${JEV_POLICY_MARKER}\nUser-maintained policy.`)).toBeUndefined();
});
test("policy teaches proactive bounded judgments and explicit repository/tool hierarchies", () => {
  expect(JEV_USAGE_POLICY).toContain("do not wait for the user");
  expect(JEV_USAGE_POLICY).toContain("deterministic cheap operation > Jev bounded semantic judgment > primary-model semantic reasoning");
  for (const concept of ["yes/no", "classification", "relevance", "risk", "confidence", "explicit scales", "known options", "candidate files", "worth reading", "contain or implement a concept", "triaging large groups", "command output or repository state"]) expect(JEV_USAGE_POLICY).toContain(concept);
  const steps = [
    "Need candidate files → deterministic search/find/glob",
    "Need semantic filtering of candidates → ask_jev_files",
    "Need a bounded judgment about one file → ask_jev_file_bool / ask_jev_file_choice / ask_jev_file_score",
    "Need exact implementation details → read the selected file with the primary model",
  ];
  const positions = steps.map((step) => JEV_USAGE_POLICY.indexOf(step));
  expect(positions.every((position) => position >= 0)).toBe(true);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
});
test("policy excludes exact deterministic answers, generation/editing and complex reasoning", () => {
  expect(JEV_USAGE_POLICY).toContain("grep, a parser, compiler, test, type checker");
  expect(JEV_USAGE_POLICY).toContain("do not call Jev unnecessarily");
  expect(JEV_USAGE_POLICY).toContain("Do not use Jev for code generation, code editing or complex multi-step reasoning");
  expect(JEV_USAGE_POLICY).toContain("passing paths or command to ask_jev instead of first loading");
  expect(JEV_USAGE_POLICY).toContain("Batch multiple questions about the same state into one Jev request");
  expect(JEV_USAGE_POLICY.split(/\s+/).length).toBeLessThan(300);
});
