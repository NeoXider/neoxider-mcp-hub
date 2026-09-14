#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { CatalogRepository } from "./catalog.js";
import { describeHub } from "./description.js";
import { CapabilityHub } from "./manager.js";
import { hubInputShape } from "./schema.js";
import type { HubWireInput } from "./wire.js";
import { argumentValue, decodeWireInput } from "./wire.js";

function errorResult(error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return { isError: true, content: [{ type: "text", text: `Error: ${message}` }] };
}

async function main(): Promise<void> {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const packageDir = path.resolve(moduleDir, "../..");
  const catalogPath = path.resolve(argumentValue("--catalog") ?? path.join(packageDir, "data", "catalog.json"));
  const stateDir = path.resolve(argumentValue("--state") ?? path.join(packageDir, "data", "state"));

  const repository = new CatalogRepository(catalogPath, stateDir);
  await repository.load();
  const hub = new CapabilityHub(repository);
  const server = new McpServer({ name: "neoxider-mcp-hub", version: "0.1.0" });
  server.server.onclose = () => void hub.close();

  server.registerTool(
    "capability_hub",
    {
      title: "Lazy MCP and skill capability hub",
      description: describeHub(repository),
      inputSchema: hubInputShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input, extra) => {
      try {
        return await hub.execute(decodeWireInput(input as HubWireInput), extra.signal);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  // A child that hangs in initialize would otherwise hold the exit for the SDK's full
  // 60s request timeout, so shutdown races a deadline rather than waiting on it.
  const shutdown = async (): Promise<void> => {
    await Promise.race([
      (async () => {
        await hub.close();
        await server.close();
      })(),
      new Promise((resolve) => setTimeout(resolve, 5000).unref()),
    ]);
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const) {
    process.once(signal, () => void shutdown().finally(() => process.exit(0)));
  }
  // StdioServerTransport never listens for end-of-input, so onclose never fires. With no
  // capability running the process happens to exit on its own, but a single live child
  // keeps the event loop alive and the hub lingers forever — one more orphan per host
  // restart. On Windows this is the only path that runs at all: SIGTERM there is
  // TerminateProcess, which no handler observes.
  process.stdin.once("end", () => void shutdown().finally(() => process.exit(0)));
  process.stdin.once("close", () => void shutdown().finally(() => process.exit(0)));

  await server.connect(new StdioServerTransport());
  process.stderr.write(`[capability-hub] ready; catalog=${catalogPath}; entries=${repository.all().length}\n`);
}

main().catch((error) => {
  process.stderr.write(`[capability-hub] fatal: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
