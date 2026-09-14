import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import { apply, Config, inject, name } from "../src/dsh-plugin.js";
import { hubInputShape } from "../src/schema.js";

interface CapturedDefinition {
  name: string;
  description: string;
  parameters: { properties?: { action?: { enum?: readonly string[] } } };
  execute(args: unknown, exec: ToolRunContext): Promise<unknown>;
}

async function applyWithEmptyCatalog(): Promise<{
  definition: CapturedDefinition;
  dispose: () => Promise<void>;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "capability-hub-dsh-plugin-"));
  const catalogPath = path.join(root, "catalog.json");
  await writeFile(catalogPath, JSON.stringify({ version: 1, entries: [] }), "utf8");
  let captured: CapturedDefinition | undefined;
  const fakeCtx = {
    tools: {
      register: (definition: unknown): (() => void) => {
        captured = definition as CapturedDefinition;
        return () => undefined;
      },
    },
  } as unknown as Parameters<typeof apply>[0];
  const dispose = await apply(fakeCtx, { catalogPath, stateDir: path.join(root, "state") });
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

test("dsh tool executes search against the same hub core", async () => {
  const { definition, dispose } = await applyWithEmptyCatalog();
  try {
    const result = (await definition.execute({ action: "search" }, { signal: signal() } as ToolRunContext)) as {
      text: string;
    };
    assert.deepEqual(JSON.parse(result.text), { capabilities: [], total: 0, truncated: false });
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
