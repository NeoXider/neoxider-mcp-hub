import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CatalogRepository } from "../src/catalog.js";
import { CapabilityHub } from "../src/manager.js";
import { describeHub, hubInstructions } from "../src/description.js";

const open = (text: string) => JSON.parse(text) as Record<string, unknown>;

async function fixture(): Promise<{ catalogPath: string; stateDir: string; root: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "capability-hub-clients-"));
  const skillDir = path.join(root, "skills", "restricted-skill");
  await mkdir(skillDir, { recursive: true });
  await writeFile(path.join(skillDir, "SKILL.md"), "# Restricted skill\n\nThe body.\n", "utf8");
  const catalogPath = path.join(root, "catalog.json");
  await writeFile(
    catalogPath,
    JSON.stringify({
      version: 1,
      entries: [
        {
          kind: "skill",
          name: "open-skill",
          description: "Visible to every client.",
          trusted: true,
          skill: { type: "file", path: path.join(root, "skills", "open-skill.md") },
        },
        {
          kind: "skill",
          name: "restricted-skill",
          description: "Visible to codex only.",
          trusted: true,
          clients: ["codex"],
          skill: { type: "file", path: path.join(skillDir, "SKILL.md") },
        },
      ],
    }),
    "utf8",
  );
  return { catalogPath, stateDir: path.join(root, "state"), root };
}

async function loadedCatalog(catalogPath: string, stateDir: string, clientId?: string): Promise<CatalogRepository> {
  const repository = new CatalogRepository(catalogPath, stateDir, clientId);
  await repository.load();
  return repository;
}

// Reads text out of both the hub's own CallToolResult and the wider union the SDK
// client returns for callTool.
const textOf = (result: unknown): string => {
  const content = (result as { content?: unknown }).content;
  return (Array.isArray(content) ? content : [])
    .map((block) => {
      const text = (block as { text?: unknown }).text;
      return typeof text === "string" ? text : "";
    })
    .join("\n");
};

test("an entry naming clients is visible only to those ids", async () => {
  const { catalogPath, stateDir } = await fixture();

  const unscoped = await loadedCatalog(catalogPath, stateDir);
  assert.deepEqual(unscoped.all().map((entry) => entry.name), ["open-skill"], "a process without an id sees the unrestricted entries");
  assert.equal(unscoped.get("restricted-skill"), undefined, "the filter must bite where names are looked up");
  assert.deepEqual(unscoped.search("").map((entry) => entry.name), ["open-skill"]);
  assert.deepEqual(unscoped.search("codex").map((entry) => entry.name), [], "search text of a hidden entry stays hidden");
  assert.doesNotMatch(describeHub(unscoped), /restricted-skill/);
  assert.doesNotMatch(hubInstructions(unscoped) ?? "", /restricted-skill/);

  const codex = await loadedCatalog(catalogPath, stateDir, "codex");
  assert.deepEqual(codex.all().map((entry) => entry.name), ["open-skill", "restricted-skill"]);
  assert.match(describeHub(codex), /restricted-skill: Visible to codex only\./);
  assert.match(hubInstructions(codex) ?? "", /restricted-skill/, "the list the model is told matches what it can load");

  const claude = await loadedCatalog(catalogPath, stateDir, "claude");
  assert.deepEqual(claude.all().map((entry) => entry.name), ["open-skill"]);
});

test("the manager refuses what the client's view hides and serves what it shows", async () => {
  const { catalogPath, stateDir } = await fixture();

  const signal = new AbortController().signal;

  // The manager throws for a name it cannot resolve and the server turns that into an
  // error result (src/server.ts), so the hidden entry must fail exactly like an unknown one.
  const hub = new CapabilityHub(await loadedCatalog(catalogPath, stateDir));
  await assert.rejects(
    hub.execute({ action: "skill.load", name: "restricted-skill" }, signal),
    /Unknown capability "restricted-skill"/,
    "an entry hidden from this identity must read as unknown",
  );

  const shown = new CapabilityHub(await loadedCatalog(catalogPath, stateDir, "codex"));
  const loaded = await shown.execute({ action: "skill.load", name: "restricted-skill" }, signal);
  assert.notEqual(loaded.isError, true);
  assert.match(textOf(loaded), /The body\./);
  assert.match(textOf(loaded), /Base directory for this skill: /);
});

test("through a real MCP client, --client decides whose list names the skill", async () => {
  const { catalogPath, stateDir } = await fixture();
  const compiledRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const serverPath = path.join(compiledRoot, "src", "server.js");

  const spawn = (clientId: string | undefined) => {
    const args = [serverPath, "--catalog", catalogPath, "--state", stateDir];
    if (clientId !== undefined) args.push("--client", clientId);
    return new StdioClientTransport({ command: process.execPath, args, stderr: "pipe" });
  };

  const scoped = new Client({ name: "capability-hub-clients-e2e", version: "0.1.0" });
  const unscoped = new Client({ name: "capability-hub-clients-e2e-plain", version: "0.1.0" });
  try {
    await scoped.connect(spawn("codex"));
    await unscoped.connect(spawn(undefined));
    assert.match(scoped.getInstructions() ?? "", /restricted-skill/);
    assert.doesNotMatch(unscoped.getInstructions() ?? "", /restricted-skill/);

    const scopedTools = await scoped.listTools();
    const unscopedTools = await unscoped.listTools();
    assert.match(JSON.stringify(scopedTools.tools[0]?.description), /restricted-skill/);
    assert.doesNotMatch(JSON.stringify(unscopedTools.tools[0]?.description), /restricted-skill/);

    const loaded = await scoped.callTool({ name: "capability_hub", arguments: { action: "skill.load", name: "restricted-skill" } });
    assert.match(textOf(loaded), /The body\./);
    const refused = await unscoped.callTool({ name: "capability_hub", arguments: { action: "skill.load", name: "restricted-skill" } });
    assert.match(textOf(refused), /Unknown capability/);
  } finally {
    await Promise.allSettled([scoped.close(), unscoped.close()]);
  }
});

test("a clients list left out of a document by zod would silently widen visibility", async () => {
  const { catalogPath, stateDir } = await fixture();
  const raw = open(await (await import("node:fs/promises")).readFile(catalogPath, "utf8"));
  const entries = raw["entries"] as Record<string, unknown>[];
  entries[0]!.clients = ["claude"];
  await writeFile(catalogPath, JSON.stringify(raw), "utf8");
  const repository = await loadedCatalog(catalogPath, stateDir, "claude");
  assert.deepEqual(repository.all().map((entry) => entry.name), ["open-skill"], "the field must survive the schema round trip");
});

test("excludeClients hides an entry from the ids it names, and wins over clients", async () => {
  const { catalogPath, stateDir } = await fixture();
  const raw = open(await (await import("node:fs/promises")).readFile(catalogPath, "utf8"));
  const entries = raw["entries"] as Record<string, unknown>[];
  // Claude Code drives its own browser, so a browser server can stay off for it alone.
  entries[0]!.excludeClients = ["claude-code"];
  entries[1]!.excludeClients = ["codex"];
  await writeFile(catalogPath, JSON.stringify(raw), "utf8");

  const claude = await loadedCatalog(catalogPath, stateDir, "claude-code");
  assert.deepEqual(claude.all().map((entry) => entry.name), [], "hidden from the id it names");
  assert.equal(claude.get("open-skill"), undefined, "and refused where names are looked up");
  assert.doesNotMatch(describeHub(claude), /open-skill/);

  const opencode = await loadedCatalog(catalogPath, stateDir, "opencode");
  assert.deepEqual(opencode.all().map((entry) => entry.name), ["open-skill"], "every other id still sees it");
  const unscoped = await loadedCatalog(catalogPath, stateDir);
  assert.deepEqual(unscoped.all().map((entry) => entry.name), ["open-skill"], "a process without an id is not excluded");

  const codex = await loadedCatalog(catalogPath, stateDir, "codex");
  assert.deepEqual(codex.all().map((entry) => entry.name), ["open-skill"], "an exclusion beats the clients list");
});
