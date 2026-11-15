import { declaredToolName } from "./description.js";
import type { ParameterTypes, RecoveredCall } from "./text-call-recovery.js";
import { isHubToolName, parseTrailingCalls } from "./text-call-recovery.js";

// OpenCode cannot be handed a recovered call the way a Harness stream can: the model
// server already returned the text, and OpenCode has no hook that turns text into a tool
// part. What it does have is a way to add a message to a stopped session. So a reply that
// ends in a written hub call is answered with one short message that names the tool as
// OpenCode declares it and repeats the arguments the model meant, and the model's next
// turn makes the real call. This module is the pure part: which reply counts, and what
// the message says. opencode-plugin.ts is the part that talks to OpenCode.

export const OPENCODE_HUB_TOOL = declaredToolName("opencode");

// The hub input keys that are not strings, so a written `true` or object is typed the way
// the declared tool expects it.
export const HUB_PARAMETER_TYPES: ParameterTypes = {
  action: "string",
  name: "string",
  tool: "string",
  arguments: "object",
  includeSchema: "boolean",
};

// The part types OpenCode appends to a finished assistant message after the text.
const TRAILING_BOOKKEEPING = new Set(["step-finish", "reasoning", "snapshot", "patch", "agent"]);

export interface MessagePart {
  type: string;
  text?: string;
}

/**
 * The written hub calls a finished assistant message ends with, or undefined when it
 * does not end in any. Text before the calls is allowed; anything real after them is not
 * (a structured call after the text means the model did call the tool). A call inside a
 * code fence, a cut-off call and a call to any other tool are not recovered.
 */
export function strandedHubCalls(parts: readonly MessagePart[]): RecoveredCall[] | undefined {
  let last: MessagePart | undefined;
  for (let index = parts.length - 1; index >= 0; index--) {
    const part = parts[index];
    if (part === undefined || TRAILING_BOOKKEEPING.has(part.type)) continue;
    last = part;
    break;
  }
  if (last?.type !== "text" || typeof last.text !== "string") return undefined;
  const parsed = parseTrailingCalls(last.text, HUB_PARAMETER_TYPES);
  if (!parsed || !parsed.calls.every((call) => isHubToolName(call.name))) return undefined;
  return parsed.calls;
}

const MAX_ARGUMENT_CHARS = 4_000;

/** The follow-up message, naming the declared tool and repeating each call's arguments. */
export function recoveryMessage(calls: readonly RecoveredCall[], toolName: string = OPENCODE_HUB_TOOL): string {
  const rendered = calls.map((call) => {
    const json = JSON.stringify(call.arguments);
    return json.length > MAX_ARGUMENT_CHARS ? `${json.slice(0, MAX_ARGUMENT_CHARS)}…` : json;
  });
  const lines = [
    `[automatic] Your last message wrote a tool call as plain text, so nothing ran. Do not write <tool_call> text: use the tool-calling interface and call the tool named exactly \`${toolName}\`, spelled in full.`,
    calls.length === 1 ? "Call it with this input:" : "Make these calls, one after another, with these inputs:",
    ...rendered.map((json, index) => (calls.length === 1 ? json : `${index + 1}. ${json}`)),
  ];
  return lines.join("\n");
}

/**
 * The name to tell the model: a hub id OpenCode lists, preferring the longest spelling,
 * else OpenCode's usual `capability_hub_capability_hub`. The ids call lists OpenCode's
 * own tools and not the MCP ones, so a miss does not mean the agent lacks the hub.
 */
export function declaredHubTool(ids: readonly string[] | undefined): string {
  const matches = (ids ?? []).filter((id) => id === "capability_hub" || id.endsWith("_capability_hub"));
  matches.sort((left, right) => right.length - left.length);
  return matches[0] ?? OPENCODE_HUB_TOOL;
}
