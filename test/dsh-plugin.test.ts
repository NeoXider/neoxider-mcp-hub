import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import { apply, Config, inject, name } from "../src/dsh-plugin.js";
import type { CapabilityHubPluginConfig } from "../src/dsh-plugin.js";
import { hubInputShape } from "../src/schema.js";

interface CapturedDefinition {
  name: string;
  description: string;
  parameters: { properties?: { action?: { enum?: readonly string[] } } };
  timeoutMs?: number;
  output: { schema: unknown; render(args: unknown, value: unknown): unknown };
  execute(args: unknown, exec: ToolRunContext): Promise<unknown>;
}

const compiledRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function emptyCatalog(): Promise<{ root: string; catalogPath: string; stateDir: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "capability-hub-dsh-plugin-"));
  const catalogPath = path.join(root, "catalog.json");
  await writeFile(catalogPath, JSON.stringify({ version: 1, entries: [] }), "utf8");
  return { root, catalogPath, stateDir: path.join(root, "state") };
}

async function applyWithEmptyCatalog(config: CapabilityHubPluginConfig = {}): Promise<{
  definition: CapturedDefinition;
  dispose: () => Promise<void>;
}> {
  const { catalogPath, stateDir } = await emptyCatalog();
  let captured: CapturedDefinition | undefined;
  const fakeCtx = {
    tools: {
      register: (definition: unknown): (() => void) => {
        captured = definition as CapturedDefinition;
        return () => undefined;
      },
    },
  } as unknown as Parameters<typeof apply>[0];
  const dispose = await apply(fakeCtx, { catalogPath, stateDir, ...config });
  assert.ok(captured, "apply registers exactly one tool");
  return { definition: captured, dispose };
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

test("dsh plugin declares its cordis identity", () => {
  assert.equal(name, "capability-hub");
  assert.deepEqual(inject, ["tools"]);
  assert.ok(Config, "a Config schema is exported for the loader");
});

test("dsh plugin Config validates through Standard Schema, the interface cordis calls", async () => {
  const accepted = await Config["~standard"].validate({ pageChars: 0, toolCallTimeoutMs: 360_000 });
  assert.equal(accepted.issues, undefined);
  const rejected = await Config["~standard"].validate({ pageChars: -1 });
  assert.ok(rejected.issues && rejected.issues.length > 0);
});

// A linked checkout resolves bare imports against this repository, not the Harness.
test("compiled dsh plugin imports nothing from @deepseek-ai at runtime", async () => {
  const source = await readFile(path.join(compiledRoot, "src", "dsh-plugin.js"), "utf8");
  assert.doesNotMatch(source, /from\s+["']@deepseek-ai\//);
  assert.doesNotMatch(source, /import\(\s*["']@deepseek-ai\//);
});

test("dsh tool action enum matches the MCP wire shape", async () => {
  const { definition, dispose } = await applyWithEmptyCatalog();
  try {
    assert.equal(definition.name, "capability_hub");
    assert.match(definition.description, /Search and inspect a compact catalog/);
    assert.deepEqual(
      [...(definition.parameters.properties?.action?.enum ?? [])],
      [...hubInputShape.action.options],
    );
  } finally {
    await dispose();
  }
});

test("dsh tool parameters are the schema the stdio server advertises", async () => {
  const { catalogPath, stateDir } = await emptyCatalog();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(compiledRoot, "src", "server.js"), "--catalog", catalogPath, "--state", stateDir],
    stderr: "pipe",
  });
  const client = new Client({ name: "capability-hub-dsh-parity", version: "0.1.0" });
  const { definition, dispose } = await applyWithEmptyCatalog();
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const { $schema: _marker, ...advertised } = (listed.tools[0]?.inputSchema ?? {}) as Record<string, unknown>;
    assert.deepEqual(definition.parameters, advertised);
    assert.equal("$schema" in definition.parameters, false);
  } finally {
    await client.close();
    await dispose();
  }
});

test("dsh tool timeout follows toolCallTimeoutMs", async () => {
  const fallback = await applyWithEmptyCatalog();
  const configured = await applyWithEmptyCatalog({ toolCallTimeoutMs: 360_000 });
  try {
    assert.equal(fallback.definition.timeoutMs, 300_000);
    assert.equal(configured.definition.timeoutMs, 360_000);
  } finally {
    await fallback.dispose();
    await configured.dispose();
  }
});

test("dsh tool executes search against the same hub core", async () => {
  const { definition, dispose } = await applyWithEmptyCatalog();
  try {
    const result = (await definition.execute({ action: "search" }, { signal: signal() } as ToolRunContext)) as {
      text: string;
    };
    assert.deepEqual(JSON.parse(result.text), { capabilities: [], total: 0, truncated: false });
    assert.deepEqual(definition.output.render({}, result), [{ type: "text", text: result.text }]);
  } finally {
    await dispose();
  }
});

test("dsh tool rejects an unknown action with the actions it takes", async () => {
  const { definition, dispose } = await applyWithEmptyCatalog();
  try {
    await assert.rejects(
      definition.execute({ action: "list_tools" }, { signal: signal() } as ToolRunContext),
      (error: Error) => /Invalid capability_hub arguments/.test(error.message) && /"tools"/.test(error.message),
    );
  } finally {
    await dispose();
  }
});

test("dsh tool keeps the length limits the schema no longer advertises", async () => {
  const { definition, dispose } = await applyWithEmptyCatalog();
  try {
    assert.doesNotMatch(JSON.stringify(definition.parameters), /maxLength/);
    await assert.rejects(
      definition.execute({ action: "inspect", name: "x".repeat(81) }, { signal: signal() } as ToolRunContext),
      /At most 80 characters/,
    );
  } finally {
    await dispose();
  }
});

test("dsh tool surfaces hub failures as thrown errors", async () => {
  const { definition, dispose } = await applyWithEmptyCatalog();
  try {
    await assert.rejects(
      definition.execute({ action: "call" }, { signal: signal() } as ToolRunContext),
      /requires name/,
    );
  } finally {
    await dispose();
  }
});
