import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "@deepseek-ai/cordis";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import { z } from "zod";
import { CatalogRepository } from "./catalog.js";
import { describeHub } from "./description.js";
import { CapabilityHub } from "./manager.js";
import { hubInputShape } from "./schema.js";
import type { HubWireInput } from "./wire.js";
import { decodeWireInput } from "./wire.js";

export const name = "capability-hub";

export const inject = ["tools"];

// Nothing from @deepseek-ai/* is imported at runtime. Loaded from a checkout by path or
// through a `link:` dependency, those bare specifiers resolve against this repository's
// node_modules rather than the Harness, so the plugin would run against whatever
// dsh-tools happened to be installed here. It registers a raw ToolRuntime definition
// instead, the form dsh-mcp-client registers, and cordis validates this Config through
// the Standard Schema interface that zod implements.
export const Config = z.object({
  catalogPath: z.string().optional(),
  stateDir: z.string().optional(),
  pageChars: z.number().int().nonnegative().optional(),
  toolCallTimeoutMs: z.number().int().positive().optional(),
});

export interface CapabilityHubPluginConfig {
  catalogPath?: string;
  stateDir?: string;
  pageChars?: number;
  toolCallTimeoutMs?: number;
}

// A hub call fans out into child MCP servers and skill loads, so the ceiling sits well
// above one child round trip instead of beside it.
const TOOL_TIMEOUT_MS = 300_000;

const inputSchema = z.object(hubInputShape);

// Projected the way the MCP SDK projects it, so the stdio server and this plugin put the
// same parameters in the prompt and a model moved between the two routes sees one tool.
// Only the SDK's `$schema` marker is left out: Harness checks tool schemas against a
// keyword subset that does not include it.
function projectParameters(): Record<string, unknown> {
  const { $schema: _marker, ...schema } = z.toJSONSchema(inputSchema, { target: "draft-7", io: "input" });
  return schema;
}

export const toolParameters = projectParameters();

const outputSchema = {
  type: "object",
  properties: { text: { type: "string" } },
  required: ["text"],
  additionalProperties: false,
};

interface ToolRegistry {
  register(definition: unknown): void;
}

function resultText(result: Awaited<ReturnType<CapabilityHub["execute"]>>): string {
  return result.content
    .map((block) => (block.type === "text" ? block.text : JSON.stringify(block)))
    .join("\n");
}

export async function apply(
  ctx: Context,
  config: CapabilityHubPluginConfig,
): Promise<() => Promise<void>> {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const packageDir = path.resolve(moduleDir, "../..");
  const repository = new CatalogRepository(
    config.catalogPath ?? path.join(packageDir, "data", "catalog.json"),
    config.stateDir ?? path.join(packageDir, "data", "state"),
  );
  await repository.load();
  const hub = new CapabilityHub(repository, config.pageChars === undefined ? {} : { pageChars: config.pageChars });
  const registry = (ctx as unknown as { tools: ToolRegistry }).tools;
  registry.register({
    name: "capability_hub",
    description: describeHub(repository),
    parameters: toolParameters,
    output: {
      schema: outputSchema,
      render: (_args: unknown, value: unknown) => [{ type: "text", text: (value as { text: string }).text }],
    },
    timeoutMs: config.toolCallTimeoutMs ?? TOOL_TIMEOUT_MS,
    async execute(args: unknown, exec: ToolRunContext) {
      // The registry does not check a raw definition's arguments, and a local server
      // that does not constrain decoding passes on whatever the model wrote, so the
      // check the MCP SDK makes on the stdio route is made here.
      const parsed = inputSchema.safeParse(args ?? {});
      if (!parsed.success) throw new Error(`Invalid capability_hub arguments:\n${z.prettifyError(parsed.error)}`);
      const outcome = await hub.execute(decodeWireInput(parsed.data as HubWireInput), exec.signal);
      const text = resultText(outcome);
      if (outcome.isError === true) {
        throw new Error(text === "" ? "capability_hub failed" : text);
      }
      return { text };
    },
    presentCall: (args: unknown) => ({
      card: "generic",
      title: "Capability hub",
      kind: "other",
      rawInput: (args as { action?: unknown } | undefined)?.action,
    }),
  });
  return async () => {
    await hub.close();
  };
}
