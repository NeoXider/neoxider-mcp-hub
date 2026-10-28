import { randomUUID } from "node:crypto";

// A local server such as Strata or llama-server turns a model's `<tool_call>` text into a
// structured call only when the function name matches a declared tool. A model that has
// seen the hub as `mcp__capability_hub__capability_hub` keeps writing variants of that
// name (`mcp__capability-hub__…`, `mcp__capability_hub`) after the tool became plain
// `capability_hub`, and every such call comes back as message text that never runs. This
// module recovers exactly those calls inside a DeepSeek Harness model stream; it adds no
// alias tool, so nothing grows in the prompt.

export const HUB_TOOL = "capability_hub";

export interface RecoveredCall {
  name: string;
  arguments: Record<string, unknown>;
}

// One raw Harness stream chunk. Only the fields this module reads are typed; every chunk
// it does not rewrite is passed on as the same object.
export interface StreamChunk {
  type: string;
  index?: number;
  text?: string;
  blockType?: string;
  block?: { type: string; text?: string; [key: string]: unknown };
  reason?: { kind: string };
  [key: string]: unknown;
}

export type ParameterTypes = Readonly<Record<string, string | undefined>>;

/** Whether a written function name is one of the spellings a model uses for the hub tool. */
export function isHubToolName(name: string): boolean {
  const segments = name.trim().toLowerCase().replace(/-/g, "_").split("__");
  return segments.includes(HUB_TOOL);
}

// Qwen's XML call format puts every value on its own lines, so one newline on each side
// belongs to the format rather than to the value.
function parameterText(raw: string): string {
  return raw.replace(/^\r?\n/, "").replace(/\r?\n$/, "");
}

function coerce(value: string, type: string | undefined): unknown {
  switch (type) {
    case "boolean":
      return value.trim() === "true" ? true : value.trim() === "false" ? false : value;
    case "number":
    case "integer": {
      const number = Number(value.trim());
      return value.trim() !== "" && Number.isFinite(number) ? number : value;
    }
    case "object":
    case "array":
      try {
        return JSON.parse(value) as unknown;
      } catch {
        return value;
      }
    default:
      return value;
  }
}

function parseXmlCall(body: string, types: ParameterTypes): RecoveredCall | undefined {
  const call = /^<function=([^>\n]+)>([\s\S]*)<\/function>$/.exec(body);
  if (!call?.[1] || call[2] === undefined) return undefined;
  const args: Record<string, unknown> = {};
  const parameter = /<parameter=([^>\n]+)>([\s\S]*?)<\/parameter>/g;
  const rest = call[2].replace(parameter, (_match, key: string, raw: string) => {
    args[key.trim()] = coerce(parameterText(raw), types[key.trim()]);
    return "";
  });
  // Anything left between the parameters is not the format this parses.
  if (rest.trim() !== "") return undefined;
  return { name: call[1].trim(), arguments: args };
}

function parseJsonCall(body: string): RecoveredCall | undefined {
  try {
    const value = JSON.parse(body) as { name?: unknown; arguments?: unknown };
    const args = typeof value.arguments === "string" ? (JSON.parse(value.arguments) as unknown) : value.arguments;
    if (typeof value.name !== "string") return undefined;
    if (args !== undefined && (args === null || typeof args !== "object" || Array.isArray(args))) return undefined;
    return { name: value.name, arguments: (args ?? {}) as Record<string, unknown> };
  } catch {
    return undefined;
  }
}

/**
 * Split text that ENDS in one or more written tool calls into the prose before them and
 * the calls. Text with anything after the calls, a call inside a code fence, or a call
 * cut off before `</function>` is not a call the model meant to make, so it yields
 * nothing.
 */
export function parseTrailingCalls(
  text: string,
  types: ParameterTypes,
): { prose: string; calls: RecoveredCall[] } | undefined {
  const open = "<tool_call>";
  const close = "</tool_call>";
  const start = text.indexOf(open);
  if (start < 0) return undefined;
  const prose = text.slice(0, start);
  if ((prose.match(/```/g)?.length ?? 0) % 2 === 1) return undefined;
  const calls: RecoveredCall[] = [];
  let rest = text.slice(start);
  while ((rest = rest.trimStart()) !== "") {
    if (!rest.startsWith(open)) return undefined;
    const end = rest.indexOf(close);
    const body = (end < 0 ? rest.slice(open.length) : rest.slice(open.length, end)).trim();
    const call = body.startsWith("{") ? parseJsonCall(body) : parseXmlCall(body, types);
    if (!call) return undefined;
    calls.push(call);
    rest = end < 0 ? "" : rest.slice(end + close.length);
  }
  return calls.length > 0 ? { prose: prose.trimEnd(), calls } : undefined;
}

/**
 * Pass a model stream through, and when it ends with no structured tool call and its
 * last text block ends in written calls to the hub, replace that text with the prose
 * before them and emit the calls as real `capability_hub` tool-call blocks.
 *
 * Text block ends are held back until the stream finishes, because a block's end fixes
 * its final text; the deltas still stream live. The provider's replay state describes
 * the message as it was written, so a recovered message drops it and the next request
 * rebuilds that message from its blocks.
 */
export async function* recoverTextCalls(
  stream: AsyncIterable<StreamChunk>,
  types: ParameterTypes,
  newId: () => string = () => `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
): AsyncGenerator<StreamChunk> {
  const texts = new Map<number, string>();
  const heldEnds = new Map<number, StreamChunk>();
  let structured = false;
  let lastText: number | undefined;
  let maxIndex = -1;

  function* release(): Generator<StreamChunk> {
    for (const chunk of heldEnds.values()) yield chunk;
    heldEnds.clear();
  }

  for await (const chunk of stream) {
    if (typeof chunk.index === "number") maxIndex = Math.max(maxIndex, chunk.index);
    if (structured) {
      yield chunk;
      continue;
    }
    const index = chunk.index ?? -1;
    if (
      chunk.type === "tool-call-delta" ||
      (chunk.type === "block-start" && chunk.blockType === "tool-call") ||
      (chunk.type === "block-end" && chunk.block?.type === "tool-call")
    ) {
      structured = true;
      yield* release();
      yield chunk;
      continue;
    }
    if (chunk.type === "text-delta") {
      texts.set(index, (texts.get(index) ?? "") + (chunk.text ?? ""));
      lastText = index;
      yield chunk;
      continue;
    }
    if (chunk.type === "block-end" && chunk.block?.type === "text") {
      texts.set(index, chunk.block.text ?? texts.get(index) ?? "");
      heldEnds.set(index, chunk);
      lastText = index;
      continue;
    }
    if (chunk.type !== "finish") {
      yield chunk;
      continue;
    }

    const kind = chunk.reason?.kind;
    const recovered =
      (kind === "stop" || kind === "tool-calls") && lastText !== undefined
        ? parseTrailingCalls(texts.get(lastText) ?? "", types)
        : undefined;
    if (!recovered || !recovered.calls.every((call) => isHubToolName(call.name))) {
      yield* release();
      yield chunk;
      continue;
    }
    const textIndex = lastText as number;
    const held = heldEnds.get(textIndex);
    heldEnds.delete(textIndex);
    yield* release();
    yield { type: "block-end", index: textIndex, block: { ...(held?.block ?? { type: "text" }), text: recovered.prose } };
    for (const call of recovered.calls) {
      const callIndex = ++maxIndex;
      const id = newId();
      const args = JSON.stringify(call.arguments);
      yield { type: "block-start", index: callIndex, blockType: "tool-call" };
      yield { type: "tool-call-delta", index: callIndex, id, name: HUB_TOOL, argumentsDelta: args };
      yield { type: "block-end", index: callIndex, block: { type: "tool-call", id, name: HUB_TOOL, arguments: args } };
    }
    const { replayState: _written, ...finish } = chunk;
    yield { ...finish, reason: kind === "stop" ? { kind: "tool-calls" } : (chunk.reason as { kind: string }) };
  }
  yield* release();
}
