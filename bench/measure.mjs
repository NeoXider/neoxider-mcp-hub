#!/usr/bin/env node
// Measures what a host actually has to put into a model's context to expose tools.
//
// Classic MCP: every configured server contributes every tool definition to the
// system prompt, permanently. Capability Hub contributes one tool definition, and
// pays instead at runtime for discovery calls. Both sides are measured here the
// same way: start the real server over stdio, ask for tools/list, and count tokens
// of the exact JSON a host injects per tool.
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { encode } from "gpt-tokenizer/encoding/o200k_base";

const benchDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(benchDir, "..");
const snapshotDir = path.join(benchDir, "snapshots");
const npx = process.platform === "win32" ? "npx.cmd" : "npx";

// Real, published MCP servers. Pinned so the published numbers stay reproducible.
const SERVERS = [
  { name: "everything", package: "@modelcontextprotocol/server-everything@2026.8.18", note: "MCP reference server" },
  { name: "memory", package: "@modelcontextprotocol/server-memory@2026.7.4", note: "Knowledge-graph memory" },
  { name: "sequential-thinking", package: "@modelcontextprotocol/server-sequential-thinking@2026.7.4", note: "Structured reasoning" },
  { name: "playwright", package: "@playwright/mcp@0.0.79", note: "Browser automation" },
];

// Skill entries for the skills measurement: one-line descriptions of the length people
// write for real skills (60-120 characters), none of them specific to this machine.
const SKILL_SAMPLE = [
  ["code-review", "Review a diff for correctness bugs first, then reuse and simplification, with file and line references."],
  ["web-research", "Signal-only web research: quick scan or deep dive, primary sources first, answer with links."],
  ["release-notes", "Write a changelog entry and release notes from the commits since the last tag."],
  ["sql-migrations", "Write reversible SQL migrations and check them against the current schema before applying."],
  ["incident-triage", "Triage a production incident: scope, timeline, mitigations and a blameless summary."],
  ["api-design", "Design or review an HTTP API: resources, errors, pagination, versioning and examples."],
  ["test-writing", "Add focused tests for a change: the public contract first, then the edge cases it touches."],
  ["docs-writing", "Write or update user documentation that matches the current behaviour, with runnable examples."],
  ["perf-profiling", "Profile a slow path, find the hot spot with measurements, and propose the smallest fix."],
  ["ml-experiment-review", "Review an ML experiment as a falsifiable, reproducible evidence package."],
];

// The heaviest real server in the catalog, so discovery is measured at its worst.
const DISCOVERY_TARGET = "playwright";

const tokens = (value) => encode(typeof value === "string" ? value : JSON.stringify(value)).length;

// A host injects at least the name, the description and the input schema per tool.
// Titles and annotations are omitted, so this is a conservative floor for the classic side.
const toolCost = (tool) =>
  tokens({ name: tool.name, description: tool.description ?? "", inputSchema: tool.inputSchema ?? {} });

const instructionCost = (client) => {
  const instructions = client.getInstructions();
  return instructions ? tokens(instructions) : 0;
};

async function withClient(command, args, env, run) {
  const transport = new StdioClientTransport({
    command,
    args,
    env: { ...process.env, ...env },
    stderr: "ignore",
  });
  const client = new Client({ name: "capability-hub-bench", version: "1.0.0" });
  try {
    await client.connect(transport);
    return await run(client);
  } finally {
    await client.close().catch(() => {});
  }
}

async function measureServer(server) {
  const snapshot = path.join(snapshotDir, `${server.name}.json`);
  if (existsSync(snapshot)) {
    const cached = JSON.parse(readFileSync(snapshot, "utf8"));
    return { ...server, ...cached, source: "snapshot" };
  }
  const listed = await withClient(npx, ["-y", server.package], {}, (client) => client.listTools(undefined, { timeout: 180_000 }));
  const tools = listed.tools.map((tool) => ({ name: tool.name, cost: toolCost(tool) }));
  const result = { tools, toolCount: tools.length, totalTokens: tools.reduce((sum, t) => sum + t.cost, 0) };
  mkdirSync(snapshotDir, { recursive: true });
  writeFileSync(snapshot, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return { ...server, ...result, source: "live" };
}

// The hub is measured exactly like the others: start it, read its real tools/list.
async function measureHub() {
  const args = [
    path.join(packageDir, "dist", "src", "server.js"),
    "--catalog", path.join(benchDir, "catalog.json"),
    "--state", path.join(benchDir, "state"),
  ];
  return withClient(process.execPath, args, {}, async (client) => {
    const listed = await client.listTools(undefined, { timeout: 180_000 });
    // Initialize instructions are resident too: hosts that honour them put them in the
    // system prompt next to the tool. The hub sends them only for a catalog with skills.
    const instructionsTokens = instructionCost(client);
    const staticTokens = listed.tools.reduce((sum, tool) => sum + toolCost(tool), 0) + instructionsTokens;

    // Runtime discovery: what a task actually spends to find and open one capability.
    const text = async (input) => {
      const result = await client.callTool({ name: "capability_hub", arguments: input }, undefined, { timeout: 180_000 });
      return result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
    };
    const search = await text({ action: "search", query: "browser automation" });
    const inspect = await text({ action: "inspect", name: DISCOVERY_TARGET });
    const enabled = await text({ action: "enable", name: DISCOVERY_TARGET });
    const toolList = await text({ action: "tools", name: DISCOVERY_TARGET });
    // `tools` accepts a query and narrows before returning, which is what an agent that
    // already knows roughly what it wants actually sends. Measuring only the unnarrowed
    // list charged the hub for 24 tool descriptions on every task.
    const narrowed = await text({ action: "tools", name: DISCOVERY_TARGET, query: "navigate" });
    await text({ action: "disable", name: DISCOVERY_TARGET });
    // An error string is cheap; counting one as "discovery cost" would fake the result.
    for (const [label, value] of [
      ["search", search], ["inspect", inspect], ["enable", enabled],
      ["tools", toolList], ["narrowed", narrowed],
    ]) {
      if (/^Error: /.test(value.trim())) throw new Error(`hub ${label} failed: ${value.trim().slice(0, 200)}`);
    }

    return {
      toolCount: listed.tools.length,
      staticTokens,
      instructionsTokens,
      discovery: {
        search: tokens(search),
        inspect: tokens(inspect),
        enable: tokens(enabled),
        tools: tokens(toolList),
        narrowed: tokens(narrowed),
        total: tokens(search) + tokens(inspect) + tokens(enabled) + tokens(toolList),
      },
    };
  });
}

// Starts the real hub against a synthetic catalog of `count` entries and reports what its
// tools/list actually costs. Entry prose is sized to the real catalog's mean, so the curve
// reflects catalogs like the ones people write rather than one-word placeholders.
async function measureHubResident(count, extraEntries = []) {
  const template = JSON.parse(readFileSync(path.join(benchDir, "catalog.json"), "utf8"));
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    const source = template.entries[index % template.entries.length];
    entries.push({ ...source, name: count === template.entries.length ? source.name : `${source.name}-${String(index).padStart(2, "0")}` });
  }
  entries.push(...extraEntries);
  const scalingCatalog = path.join(snapshotDir, "scaling-catalog.tmp.json");
  mkdirSync(snapshotDir, { recursive: true });
  writeFileSync(scalingCatalog, JSON.stringify({ version: 1, entries }), "utf8");
  try {
    const args = [
      path.join(packageDir, "dist", "src", "server.js"),
      "--catalog", scalingCatalog,
      "--state", path.join(benchDir, "state"),
    ];
    return await withClient(process.execPath, args, {}, async (client) => {
      const listed = await client.listTools(undefined, { timeout: 180_000 });
      const tool = listed.tools.reduce((sum, entry) => sum + toolCost(entry), 0);
      const instructions = instructionCost(client);
      return extraEntries.length === 0 ? tool + instructions : { tool, instructions, total: tool + instructions };
    });
  } finally {
    rmSync(scalingCatalog, { force: true });
  }
}

async function main() {
  const measured = [];
  for (const server of SERVERS) {
    process.stderr.write(`measuring ${server.name}...\n`);
    try {
      measured.push(await measureServer(server));
    } catch (error) {
      process.stderr.write(`  SKIPPED ${server.name}: ${error instanceof Error ? error.message : String(error)}\n`);
      measured.push({ ...server, skipped: true, reason: String(error) });
    }
  }
  process.stderr.write("measuring capability hub...\n");
  const hub = await measureHub();

  const usable = measured.filter((entry) => !entry.skipped);
  const classicTotal = usable.reduce((sum, entry) => sum + entry.totalTokens, 0);
  const classicTools = usable.reduce((sum, entry) => sum + entry.toolCount, 0);

  // There is no single "per task" number, and reporting one was the previous version's
  // mistake: it charged every task the most expensive path (search + inspect + enable +
  // the unnarrowed tool list) and published the result as typical. Three scenarios,
  // ordered by how often they actually occur:
  //
  //   idle     the task needs no capability. This is the common case in a real session,
  //            and it costs nothing beyond the resident broker schema.
  //   direct   the task opens one capability and knows roughly what it wants. `tools`
  //            starts the server itself, so `enable` is not on this path.
  //   cautious the agent also reviews permissions and reads the full tool list.
  //
  // The cost of the tool's own result is excluded throughout: classic MCP pays exactly
  // the same tokens for it, so it cancels and does not belong in an overhead comparison.
  const d = hub.discovery;
  const scenarios = {
    idle: { tokens: hub.staticTokens, path: "resident schema only" },
    direct: { tokens: hub.staticTokens + d.search + d.narrowed, path: "search + tools(query), auto-enabled" },
    cautious: { tokens: hub.staticTokens + d.total, path: "search + inspect + enable + full tools" },
  };
  for (const value of Object.values(scenarios)) {
    value.percentSaved = Number((100 * (1 - value.tokens / classicTotal)).toFixed(1));
    value.ratio = Number((classicTotal / value.tokens).toFixed(1));
  }

  // How the saving moves as the catalog grows.
  //
  // The hub's resident cost is NOT a constant: since the capability list ships inside the
  // tool description, it grows with the catalog too — just far more slowly, and it stops
  // growing once the list degrades to names-only and then to a bare count. Assuming a
  // constant here would have overstated every row, so the hub side is measured by
  // actually starting the server against synthetic catalogs of each size and reading its
  // real tools/list. Only the classic side is projected, from the measured mean per server.
  const perServer = classicTotal / usable.length;
  const scaling = [];
  for (const servers of [4, 7, 10, 15, 20, 30, 43, 60]) {
    const classic = Math.round(perServer * servers);
    const resident = await measureHubResident(servers);
    scaling.push({
      servers,
      classicTokens: classic,
      hubResidentTokens: resident,
      percentSaved: Number((100 * (1 - resident / classic)).toFixed(1)),
    });
  }

  // What skills add. Ten skill entries with one-line descriptions of a typical length,
  // on top of the four measured servers: the tool description gains a skill section and
  // initialize gains instructions that tell the model to check them before each task.
  const skills = await measureHubResident(4, SKILL_SAMPLE.map(([name, description]) => ({
    kind: "skill",
    name,
    description,
    trusted: true,
    skill: { type: "file", path: "${packageDir}/data/skills/ml-experiment-review/SKILL.md" },
  })));

  const report = {
    measuredAt: process.env.BENCH_TIMESTAMP ?? null,
    encoding: "o200k_base",
    servers: measured,
    classic: { servers: usable.length, tools: classicTools, staticTokens: classicTotal, meanTokensPerServer: Math.round(perServer) },
    hub: { staticTokens: hub.staticTokens, discovery: hub.discovery, scenarios },
    scaling,
    skills: { count: SKILL_SAMPLE.length, servers: 4, toolTokens: skills.tool, instructionsTokens: skills.instructions, residentTokens: skills.total },
    savings: {
      staticRatio: Number((classicTotal / hub.staticTokens).toFixed(1)),
      staticPercent: scenarios.idle.percentSaved,
      directPercent: scenarios.direct.percentSaved,
      cautiousPercent: scenarios.cautious.percentSaved,
      // Break-even against the cheap path, which is the one an agent repeats.
      breakEvenDirect: Number((classicTotal / (d.search + d.narrowed)).toFixed(1)),
      breakEvenCautious: Number((classicTotal / d.total).toFixed(1)),
    },
  };

  writeFileSync(path.join(benchDir, "results.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");

  const rows = usable.map((entry) =>
    `| \`${entry.package.split("@").slice(0, -1).join("@")}\` | ${entry.note} | ${entry.toolCount} | ${entry.totalTokens.toLocaleString("en-US")} |`,
  );
  console.log(`| Server | Purpose | Tools | Context tokens |`);
  console.log(`|---|---|---:|---:|`);
  console.log(rows.join("\n"));
  console.log(`| **Total (classic MCP)** | | **${classicTools}** | **${classicTotal.toLocaleString("en-US")}** |`);
  console.log(`| **Capability Hub** | one broker tool | **${hub.toolCount}** | **${hub.staticTokens.toLocaleString("en-US")}** |`);
  console.log("");
  console.log(`| Scenario | Path | Hub tokens | vs classic ${classicTotal.toLocaleString("en-US")} |`);
  console.log(`|---|---|---:|---:|`);
  for (const [name, s] of Object.entries(scenarios)) {
    console.log(`| ${name} | ${s.path} | ${s.tokens.toLocaleString("en-US")} | **${s.percentSaved}%** saved |`);
  }
  console.log("");
  console.log(`| Servers configured | Classic tokens | Hub resident | Saved |`);
  console.log(`|---:|---:|---:|---:|`);
  for (const row of scaling) {
    console.log(
      `| ${row.servers} | ${row.classicTokens.toLocaleString("en-US")} | ${row.hubResidentTokens.toLocaleString("en-US")} | ${row.percentSaved}% |`,
    );
  }
  console.log("");
  console.log(`With ${SKILL_SAMPLE.length} skills: ${skills.tool.toLocaleString("en-US")} tool + ${skills.instructions.toLocaleString("en-US")} instructions = ${skills.total.toLocaleString("en-US")} resident tokens`);
  console.log(`Break-even: ~${report.savings.breakEvenDirect} direct discoveries, or ~${report.savings.breakEvenCautious} cautious ones, in a single session`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
