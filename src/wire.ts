import { capabilityEntrySchema } from "./schema.js";
import type { CapabilityEntry, HubInput, JsonValue } from "./types.js";

export interface HubWireInput {
  action: HubInput["action"];
  query?: string;
  kind?: "mcp" | "skill";
  name?: string;
  tool?: string;
  payloadJson?: string;
  includeSchema?: boolean;
}
// `argumentsJson`, `configJson` and `entryJson` were replaced by `payloadJson` in 0.5.0.
// Reading them here as a compatibility shim was tried and removed: the MCP SDK validates
// the incoming object against the advertised shape and STRIPS unknown keys before the
// handler runs, so the shim could never fire. A caller pinned to the old names does not
// get a deprecation path — it gets an empty payload and a confusing error from the child.
// This is a breaking change, and pretending otherwise in a comment was worse than saying so.

function parseJsonObject(text: string, field: string): Record<string, JsonValue> {
  const value: unknown = JSON.parse(text);
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`${field} must contain a JSON object`);
  }
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

  const argumentsJson = payloadTarget === "arguments" ? input.payloadJson : undefined;
  const configJson = payloadTarget === "config" ? input.payloadJson : undefined;
  const entryJson = payloadTarget === "entry" ? input.payloadJson : undefined;

  return {
    action: input.action,
    ...(input.query === undefined ? {} : { query: input.query }),
    ...(input.kind === undefined ? {} : { kind: input.kind }),
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.tool === undefined ? {} : { tool: input.tool }),
    ...(argumentsJson === undefined ? {} : { arguments: parseJsonObject(argumentsJson, "payloadJson") }),
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
