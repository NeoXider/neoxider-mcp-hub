import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import z from "@deepseek-ai/schemastery";
import { CatalogRepository } from "./catalog.js";
import { describeHub } from "./description.js";
import { CapabilityHub } from "./manager.js";
import type { HubWireInput } from "./wire.js";
import { decodeWireInput } from "./wire.js";

export const name = "capability-hub";

export const inject = ["tools"];

export const Config = z.object({
  catalogPath: z.string().required(false),
  stateDir: z.string().required(false),
});

export interface CapabilityHubPluginConfig {
  catalogPath?: string;
  stateDir?: string;
}

// A hub call fans out into child MCP servers and skill loads, so the ceiling sits well
// above one child round trip instead of beside it.
const TOOL_TIMEOUT_MS = 300_000;

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
  const hub = new CapabilityHub(repository);
  const registry = (ctx as unknown as { tools: ToolRegistry }).tools;
  registry.register(
    defineTool({
      name: "capability_hub",
      description: describeHub(repository),
      parameters: {
        action: {
          type: "string",
          required: true,
          enum: [
            "search",
            "inspect",
            "status",
            "configure",
            "enable",
            "disable",
            "tools",
            "call",
            "skill.load",
            "propose",
            "proposals",
            "catalog.reload",
          ],
          description: "Operation to perform.",
        },
        query: {
          type: "string",
          description:
            "Search text. With action search it filters the catalog; with action tools it filters that server's tool names and descriptions.",
        },
        kind: {
          type: "string",
          enum: ["mcp", "skill"],
          description: "Optional capability type filter.",
        },
        name: { type: "string", description: "Exact capability name." },
        tool: { type: "string", description: "Raw child MCP tool name for call." },
        payloadJson: {
          type: "string",
          description:
            'JSON object for the action: arguments for call (e.g. {"url":"https://example.com"}), non-secret whitelisted configuration for configure and enable, or a capability proposal for propose.',
        },
        arguments: {
          type: "object",
          additionalProperties: true,
          description:
            'Call arguments as an object (e.g. {"url":"https://example.com"}). Prefer this over payloadJson for action call; the two must not be combined.',
        },
        includeSchema: {
          type: "boolean",
          description: "Include full child tool schemas. Leave false unless arguments cannot be inferred.",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            text: { type: "string", required: true },
          },
        },
        render: (_args, value) => [{ type: "text", text: (value as { text: string }).text }],
      },
      timeoutMs: TOOL_TIMEOUT_MS,
      async execute(args, exec: ToolRunContext) {
        const outcome = await hub.execute(decodeWireInput(args as HubWireInput), exec.signal);
        const text = resultText(outcome);
        if (outcome.isError === true) {
          throw new Error(text === "" ? "capability_hub failed" : text);
        }
        return { text };
      },
      presentCall: (args) => ({
        card: "generic",
        title: "Capability hub",
        kind: "other",
        rawInput: (args as { action?: unknown }).action,
      }),
    }),
  );
  return async () => {
    await hub.close();
  };
}
