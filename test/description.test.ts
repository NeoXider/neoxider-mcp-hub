import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CatalogRepository } from "../src/catalog.js";
import {
  BASE_DESCRIPTION,
  INLINE_SKILL_CHAR_BUDGET,
  SKILL_LINE_CHARS,
  declaredToolName,
  describeHub,
  hubInstructions,
  oneLine,
} from "../src/description.js";

const server = (index: number, description: string) => ({
  kind: "mcp" as const,
  name: `server-${String(index).padStart(3, "0")}`,
  description,
  trusted: true,
  transport: { type: "stdio" as const, command: "node", args: ["unused.js"] },
});

const skill = (name: string, description: string) => ({
  kind: "skill" as const,
  name,
  description,
  trusted: true,
  skill: { type: "file" as const, path: "unused.md" },
});

async function repositoryOf(entries: unknown[]): Promise<CatalogRepository> {
  const root = await mkdtemp(path.join(os.tmpdir(), "capability-hub-description-"));
  const catalogPath = path.join(root, "catalog.json");
  await writeFile(catalogPath, JSON.stringify({ version: 1, entries }), "utf8");
  const repository = new CatalogRepository(catalogPath, path.join(root, "state"));
  await repository.load();
  return repository;
}

test("a catalog without skills describes itself as before and sends no instructions", async () => {
  const repository = await repositoryOf([server(0, "Echo things."), server(1, "Echo more things.")]);
  assert.equal(
    describeHub(repository),
    `${BASE_DESCRIPTION}\nAvailable capabilities — server-000 (mcp): Echo things. | server-001 (mcp): Echo more things.`,
    "the resident text of a server-only catalog must not move, or every published measurement moves with it",
  );
  assert.equal(hubInstructions(repository), undefined, "nothing to remind the model of, so no resident cost");
});

test("skills keep their descriptions when the server list degrades to names", async () => {
  const verbose = "A deliberately long server description that keeps going so a few dozen of them overflow the inline budget.";
  const repository = await repositoryOf([
    ...Array.from({ length: 40 }, (_, index) => server(index, verbose)),
    skill("game-research", "Answer game questions from official and Steam sources only."),
    skill("timecodes", "Make stream timecodes from a VTT transcript."),
  ]);
  const description = describeHub(repository);
  assert.doesNotMatch(description, /deliberately long server description/, "the server list degraded to names");
  assert.match(description, /server-039/, "every server is still named");
  assert.match(description, /game-research: Answer game questions from official and Steam sources only\./);
  assert.match(description, /timecodes: Make stream timecodes/);
  assert.match(description, /before starting a task, load each skill below that fits it with action "skill\.load"/);
});

test("initialize instructions tell the model to check skills before it starts", async () => {
  const repository = await repositoryOf([
    server(0, "Echo things."),
    skill("game-research", "Answer game questions from official and Steam sources only."),
  ]);
  const instructions = hubInstructions(repository);
  assert.ok(instructions !== undefined);
  assert.match(instructions, /at the start of every task/);
  assert.match(instructions, /\{"action":"skill\.load","name":"<skill>"\}/);
  assert.match(instructions, /game-research: Answer game questions/);
  assert.doesNotMatch(instructions, /server-000/, "servers stay in the tool description, not here");
});

test("instructions name the tool the way the client declares it", async () => {
  const repository = await repositoryOf([skill("game-research", "Answer game questions.")]);
  // OpenCode lists it as capability_hub_capability_hub; a model told the bare name wrote
  // that, the model server found no such tool, and the call stayed text in the chat.
  const opencode = hubInstructions(repository, declaredToolName("opencode")) ?? "";
  assert.match(opencode, /^capability_hub_capability_hub holds skills/);
  assert.match(opencode, /call capability_hub_capability_hub with \{"action":"skill\.load"/);
  assert.doesNotMatch(opencode.replace(/capability_hub_capability_hub/g, ""), /capability_hub/, "no bare name left");
  assert.equal(declaredToolName(undefined), "capability_hub");
  assert.equal(declaredToolName("claude-code"), "mcp__capability_hub__capability_hub");
  assert.equal(declaredToolName("codex"), "capability_hub", "an unknown naming keeps the tool's own name");
  assert.match(opencode, /only capability_hub_capability_hub loads them/, "not the client's own skill tool");
  assert.equal(hubInstructions(repository), hubInstructions(repository, "capability_hub"), "the default is unchanged");
});

test("one long skill description cannot crowd out the rest", async () => {
  const repository = await repositoryOf([
    skill("long-skill", `${"word ".repeat(200)}end`),
    skill("short-skill", "Short and clear."),
  ]);
  const description = describeHub(repository);
  const line = /long-skill: ([^|]*) \|/.exec(description)?.[1] ?? "";
  assert.ok(line.length <= SKILL_LINE_CHARS, `capped at ${String(SKILL_LINE_CHARS)} chars, got ${String(line.length)}`);
  assert.match(line, /…$/, "a cut description says it was cut");
  assert.match(description, /short-skill: Short and clear\./);
});

test("a large skill catalog degrades to names, then to a count, and stays bounded", async () => {
  const many = (count: number, prefix: string) =>
    Array.from({ length: count }, (_, index) =>
      skill(`${prefix}-${String(index).padStart(3, "0")}`, "A skill whose description is long enough to matter in the inline budget."),
    );
  const names = describeHub(await repositoryOf(many(40, "skill")));
  assert.doesNotMatch(names, /long enough to matter/);
  assert.match(names, /skill-039/);
  assert.match(names, /kind "skill"/, "the model is told how to recover the descriptions");

  const counted = describeHub(await repositoryOf(many(200, "a-skill-with-a-rather-long-name")));
  assert.doesNotMatch(counted, /a-skill-with-a-rather-long-name-199/);
  assert.match(counted, /200 skills are available/);
  assert.ok(counted.length < BASE_DESCRIPTION.length + INLINE_SKILL_CHAR_BUDGET);
});

test("oneLine flattens whitespace and cuts at a word boundary", () => {
  assert.equal(oneLine("  two\n lines  ", 50), "two lines");
  assert.equal(oneLine("alpha beta gamma delta", 12), "alpha beta…");
  assert.ok(oneLine("x".repeat(300), 40).length <= 40);
});
