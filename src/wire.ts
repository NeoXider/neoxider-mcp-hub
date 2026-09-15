import { capabilityEntrySchema } from "./schema.js";
import type { CapabilityEntry, HubInput, JsonValue } from "./types.js";

export interface HubWireInput {
  action: HubInput["action"];
  query?: string;
  kind?: "mcp" | "skill";
  name?: string;
  tool?: string;
  payloadJson?: string;
  arguments?: Record<string, unknown>;
  includeSchema?: boolean;
}
// `argumentsJson`, `configJson` and `entryJson` were replaced by `payloadJson` in 0.5.0.
// They stay unhandled on purpose: the MCP SDK validates the incoming object against
// the advertised shape and STRIPS unknown keys before the handler runs, so reading
// them here could never fire. A caller pinned to the old names does not get a
// deprecation path — it gets an empty payload and a confusing error from the child.
// The structured `arguments` object below is the supported alternative, and it works
// precisely because it IS advertised in hubInputShape rather than shimmed here.

function parseJsonObject(text: string, field: string): Record<string, JsonValue> {
  const value: unknown = JSON.parse(text);
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`${field} must contain a JSON object`);
  }
  return value as Record<string, JsonValue>;
}

// The structured `arguments` object arrives already parsed, so JSON.parse cannot
// vouch for it. Non-JSON values (undefined, functions, symbols) would otherwise be
// silently dropped or crash the child call, and non-finite numbers would arrive as
// null — each worth hearing about at this boundary rather than downstream.
function checkJsonValue(value: unknown, field: string): void {
  if (value === null) return;
  switch (typeof value) {
    case "string":
    case "boolean":
      return;
    case "number":
      if (!Number.isFinite(value)) throw new Error(`${field} must contain JSON-serializable values`);
      return;
    case "object": {
      if (Array.isArray(value)) {
        value.forEach((item) => checkJsonValue(item, field));
        return;
      }
      for (const item of Object.values(value as Record<string, unknown>)) checkJsonValue(item, field);
      return;
    }
    default:
      throw new Error(`${field} must contain JSON-serializable values`);
  }
}

function asJsonObject(value: Record<string, unknown>, field: string): Record<string, JsonValue> {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`${field} must contain a JSON object`);
  }
  checkJsonValue(value, field);
  return value as Record<string, JsonValue>;
}

// `payloadJson` means whatever the action needs, so it is routed by action rather than
// guessed at. Sending it with an action that has no payload is an error rather than a
// silent no-op: a model that puts call arguments on `enable` has made a mistake worth
// hearing about, and the alternative is a capability that starts and does nothing.
const PAYLOAD_TARGET: Partial<Record<HubInput["action"], "arguments" | "config" | "entry">> = {
  call: "arguments",
  configure: "config",
  enable: "config",
  propose: "entry",
};

export function decodeWireInput(input: HubWireInput): HubInput {
  const payloadTarget = PAYLOAD_TARGET[input.action];

  if (input.payloadJson !== undefined && payloadTarget === undefined) {
    throw new Error(
      `Action "${input.action}" takes no payloadJson; it is for call, configure, enable and propose`,
    );
  }

  // The structured object is only advertised for `call`. Anything else is the same
  // class of mistake as a misrouted payloadJson: worth an error, not a silent no-op.
  if (input.arguments !== undefined && input.action !== "call") {
    throw new Error(`Action "${input.action}" takes no arguments; it is for action "call"`);
  }
  if (input.arguments !== undefined && input.payloadJson !== undefined) {
    throw new Error('Pass call arguments either as "arguments" or as "payloadJson", not both');
  }

  const argumentsJson = payloadTarget === "arguments" ? input.payloadJson : undefined;
  const configJson = payloadTarget === "config" ? input.payloadJson : undefined;
  const entryJson = payloadTarget === "entry" ? input.payloadJson : undefined;

  const structuredArguments = input.action === "call" && input.arguments !== undefined
    ? asJsonObject(input.arguments, "arguments")
    : undefined;

  return {
    action: input.action,
    ...(input.query === undefined ? {} : { query: input.query }),
    ...(input.kind === undefined ? {} : { kind: input.kind }),
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.tool === undefined ? {} : { tool: input.tool }),
    ...(argumentsJson === undefined ? {} : { arguments: parseJsonObject(argumentsJson, "payloadJson") }),
    ...(structuredArguments === undefined ? {} : { arguments: structuredArguments }),
    ...(configJson === undefined ? {} : { config: parseJsonObject(configJson, "payloadJson") }),
    ...(entryJson === undefined
      ? {}
      : { entry: capabilityEntrySchema.parse(JSON.parse(entryJson)) as CapabilityEntry }),
    ...(input.includeSchema === undefined ? {} : { includeSchema: input.includeSchema }),
  };
}

export function argumentValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
