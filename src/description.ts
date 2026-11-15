import type { CatalogRepository } from "./catalog.js";
import type { CapabilityEntry } from "./types.js";

// The description is part of the system prompt on every request, and a local server's
// prompt cache only survives as long as that prefix stays byte-identical. So it holds no
// state at all — not which servers are running, not counts, not times — only the catalog,
// which changes when the operator edits it and never during a conversation.
export const BASE_DESCRIPTION =
  "Search and inspect a compact catalog, enable a trusted MCP only when needed, list its tools, proxy a tool call, or load one skill body. " +
  'Shortest path: action "call" with name, tool and arguments starts the server by itself; ' +
  'use action "tools" (optionally with a query) first only when you do not know the tool name, and "enable" only to start one deliberately. ' +
  'Long results arrive in pages: continue with action "page" and the cursor printed on the last line. ' +
  "Avoid includeSchema unless you need the argument shape. Third-party proposals require human approval outside this MCP.";

// Roughly four characters per token; a hard character budget keeps the resident cost
// bounded without dragging a tokenizer into the server's dependencies.
export const INLINE_CATALOG_CHAR_BUDGET = 3_000;

// Skills get a budget of their own. Sharing the server budget meant one verbose server
// description, or one skill too many, flipped the WHOLE list to bare names — and a skill
// whose name is all the model sees ("gamer-signal", "researcher") is a skill it does not
// know to load. A skill line is also capped, so one long entry cannot crowd out the rest.
export const INLINE_SKILL_CHAR_BUDGET = 1_500;
export const SKILL_LINE_CHARS = 120;

// Skills are passive: unlike a server, nothing about the task makes the model reach for
// one, and a model that was never told to look simply never loads them. So the listing
// says when to look (before starting) and how to load, not only what exists.
export const SKILL_GUIDANCE =
  'before starting a task, load each skill below that fits it with action "skill.load" and its name, then follow it';

// One line, at most `max` characters, cut at a word boundary. Catalog descriptions are
// written by people and may run to paragraphs; the inline list needs a sentence.
export function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.—-]+$/u, "")}…`;
}

function serverListing(servers: readonly CapabilityEntry[]): string {
  const detailed = servers.map((entry) => `${entry.name} (${entry.kind}): ${entry.description}`).join(" | ");
  if (detailed.length <= INLINE_CATALOG_CHAR_BUDGET) return `Available capabilities — ${detailed}`;
  const names = servers.map((entry) => entry.name).join(", ");
  if (names.length <= INLINE_CATALOG_CHAR_BUDGET) {
    return `Available capabilities: ${names}. Use action "search" for descriptions.`;
  }
  return `${servers.length} capabilities are available; use action "search" to list them.`;
}

// The skill list, degrading the same way the server list does: capped one-line
// descriptions, then names, then a count with a pointer to `search`.
export function skillListing(skills: readonly CapabilityEntry[], lead = `Skills — ${SKILL_GUIDANCE}`): string {
  const detailed = skills.map((entry) => `${entry.name}: ${oneLine(entry.description, SKILL_LINE_CHARS)}`).join(" | ");
  if (detailed.length <= INLINE_SKILL_CHAR_BUDGET) return `${lead}: ${detailed}`;
  const names = skills.map((entry) => entry.name).join(", ");
  if (names.length <= INLINE_SKILL_CHAR_BUDGET) {
    return `${lead}: ${names}. Action "search" with kind "skill" gives their descriptions.`;
  }
  return `${lead}. ${skills.length} skills are available; action "search" with kind "skill" and a query finds them.`;
}

// The capability list ships INSIDE the resident description, rather than being something
// the model has to spend a `search` round trip to discover.
//
// This is not a guess. bench/accuracy.mjs measured the same 28 tasks on the same model
// with and without it: 92.9% -> 100% accuracy, and average turns 3.96 -> 2.43, for 223
// extra resident tokens on a four-entry catalog. The failures it removed were the ones
// where the task does not read like a search query, so the model never searched at all
// and simply answered without the capability.
//
// A large catalog would undo the saving this whole project exists for, so each list
// degrades: full descriptions, then names only, then a pointer to `search`. A catalog
// without skills describes itself exactly as it did before skills had a section.
export function describeHub(repository: CatalogRepository): string {
  const entries = repository.all();
  if (entries.length === 0) return BASE_DESCRIPTION;
  const servers = entries.filter((entry) => entry.kind === "mcp");
  const skills = entries.filter((entry) => entry.kind === "skill");
  const sections = [BASE_DESCRIPTION];
  if (servers.length > 0) sections.push(serverListing(servers));
  if (skills.length > 0) sections.push(skillListing(skills));
  return sections.join("\n");
}

export const HUB_TOOL_NAME = "capability_hub";

// What a client calls this tool when it lists it to the model, for a client whose naming
// is known and the server key the README uses (`capability_hub`). OpenCode joins the
// server key and the tool name with "_" (`McpCatalog.toolName`); Claude Code writes
// `mcp__<server>__<tool>`.
const CLIENT_TOOL_NAMES: Readonly<Record<string, string>> = {
  opencode: "capability_hub_capability_hub",
  "claude-code": "mcp__capability_hub__capability_hub",
};

export function declaredToolName(clientId?: string): string {
  return (clientId === undefined ? undefined : CLIENT_TOOL_NAMES[clientId]) ?? HUB_TOOL_NAME;
}

// The MCP `instructions` a server returns at initialize. Hosts such as Claude Code put
// them in the system prompt, and that is the one place a model reads before its first
// turn: with tool search on, Claude Code defers the tool description itself until the
// model searches for a tool, so a skill list kept only there is never seen at the start
// of a task. Without skills there is nothing a model would otherwise miss, so nothing is
// sent and a server-only catalog pays no extra resident tokens.
//
// The tool is named as the client declares it. An open-weight model always writes its
// call as text (`<tool_call><function=NAME>…`), and the model server turns that text
// into a tool call only when NAME is a tool the request declared. Told "capability_hub"
// while OpenCode declares `capability_hub_capability_hub`, a model wrote the name it was
// told, and every such call reached the chat as text and never ran.
export function hubInstructions(repository: CatalogRepository, toolName = HUB_TOOL_NAME): string | undefined {
  const skills = repository.all().filter((entry) => entry.kind === "skill");
  if (skills.length === 0) return undefined;
  return (
    // OpenCode has a `skill` tool of its own, and a model told only "holds skills" asked it
    // for a hub skill first and got an error.
    `${toolName} holds skills: task instructions that stay out of your context until loaded, and only ${toolName} loads them. ` +
    `Check them at the start of every task, and when one fits, call ${toolName} with {"action":"skill.load","name":"<skill>"} ` +
    "before you begin and follow what it returns. MCP servers in the same catalog start on demand; the tool description lists them.\n" +
    skillListing(skills, "Skills")
  );
}
