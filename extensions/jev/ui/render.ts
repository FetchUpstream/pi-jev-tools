import type { Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { formatCall, formatResult, type DisplayArgs, type DisplayDetails, type Line, type Tone, type ToolName } from "./format.ts";

const colors = {
  title: "toolTitle", question: "muted", answer: "toolOutput",
  muted: "dim", warning: "warning", error: "error",
} as const satisfies Record<Tone, Parameters<Theme["fg"]>[0]>;

function component(rows: Line[], theme: Theme): Text {
  return new Text(rows.map((row) => {
    const text = row.tone === "title" ? theme.bold(row.text) : `  ${row.text}`;
    return theme.fg(colors[row.tone], text);
  }).join("\n"), 0, 0);
}

/** Render only details + original arguments; never replace model-visible content. */
export function toolRenderers(name: ToolName): Pick<ToolDefinition, "renderCall" | "renderResult"> {
  return {
    renderCall: (args, theme) => component(formatCall(name, args as DisplayArgs), theme),
    renderResult: (result, options, theme, context) => component(formatResult(
      name, context.args as DisplayArgs, result.details as DisplayDetails | undefined,
      {
        ...options, isError: context.isError,
        errorText: context.isError && !result.details
          ? result.content.filter((entry) => entry.type === "text").map((entry) => entry.text).join(" ")
          : undefined,
      },
    ), theme),
  };
}
