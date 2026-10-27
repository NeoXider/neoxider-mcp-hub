import { readFile, stat } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CatalogRepository } from "./catalog.js";
import type {
  CapabilityEntry,
  HubInput,
  JsonValue,
  McpCapabilityEntry,
  SkillCapabilityEntry,
} from "./types.js";

interface LiveMcp {
  readonly entry: McpCapabilityEntry;
  readonly client: Client;
  tools: Tool[];
}

const SECRET_KEY_PATTERN = /(secret|token|password|passwd|api[-_.]?key|credential|private[-_.]?key)/i;
const MAX_SKILL_BYTES = 256 * 1024;
const MAX_SEARCH_RESULTS = 50;
const MAX_TOOL_RESULTS = 60;
const MAX_PROPOSAL_RESULTS = 25;
const MAX_FIELD_CHARS = 400;
const MAX_TAGS = 10;
const MAX_TAG_CHARS = 60;
const MAX_CALL_RESULT_CHARS = 200_000;
// DeepSeek Harness's tool-result pruner rewrites any tool result longer than 8,192
// characters once the window comes under pressure: it swaps the middle for a marker in a
// message that was already sent. Every token after that point then no longer matches what
// a local server such as Strata or llama.cpp holds in its prompt cache, so the whole tail
// of the conversation is read again on the next request. A result that never exceeds the
// threshold is never rewritten, so long answers are served in pages below it.
export const DEFAULT_PAGE_CHARS = 7_500;
// Pages are kept for the life of the hub process, bounded so a long session cannot grow
// without limit: the oldest result is dropped first.
const MAX_PAGED_RESULTS = 32;
const MAX_SUGGESTIONS = 8;
// Setting any of these makes the child interpreter load code before the server's own
// entry point runs, so a value reaching one of them is arbitrary code execution — no
// matter how innocuous the catalog key that produced it looks.
// Only these mean the pipe to the child is gone. Anything else — a tool that returned an
// error, a schema mismatch, a local stringify blowing the stack — leaves the child alive.
const TRANSPORT_FAILURE = /connection closed|EPIPE|ECONNRESET|ECONNREFUSED|terminated|socket hang up|write after end/i;

// JSON-RPC "Method not found". Matched on the code where the SDK exposes one and on the
// message otherwise, because the error crosses a transport boundary and not every server
// preserves the typed shape.
function isMethodNotFound(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === -32601) return true;
  return /-32601|method not found/i.test(error instanceof Error ? error.message : String(error));
}
const LOADER_ENV = /^(NODE_OPTIONS|NODE_REPL_EXTERNAL_MODULE|LD_PRELOAD|LD_AUDIT|LD_LIBRARY_PATH|DYLD_[A-Z_]+|PYTHONSTARTUP|PYTHONPATH|PERL5OPT|PERL5LIB|RUBYOPT|BASH_ENV|ENV|GIT_SSH|GIT_SSH_COMMAND|GIT_EXTERNAL_DIFF)$/i;

function asStructured(value: JsonValue): Record<string, unknown> {
  return Array.isArray(value) || value === null || typeof value !== "object" ? { value } : value;
}

// Every byte here lands in the model's context, and indentation is not information:
// pretty-printing this payload measured 31% more tokens than the compact form.
// Programmatic clients still get the parsed object through structuredContent.
function jsonResult(value: JsonValue): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: asStructured(value),
  };
}

function textResult(text: string, metadata?: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text }],
    ...(metadata === undefined ? {} : { structuredContent: metadata }),
  };
}

function requireName(input: HubInput): string {
  if (!input.name) throw new Error(`Action "${input.action}" requires name`);
  return input.name;
}

// Capping the number of rows was never enough: the schema allows a 2,000-character
// description and 100 tags of 500 characters each, so 50 rows measured 2.6 MB of
// model-facing text. A row limit without a field limit is not a limit.
function truncate(value: string, limit = MAX_FIELD_CHARS): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

function publicEntry(entry: CapabilityEntry, enabled: boolean): Record<string, JsonValue> {
  return {
    kind: entry.kind,
    name: entry.name,
    description: truncate(entry.description),
    tags: (entry.tags ?? []).slice(0, MAX_TAGS).map((tag) => truncate(tag, MAX_TAG_CHARS)),
    trusted: entry.trusted,
    enabled,
  };
}

function environmentStatus(names: readonly string[]): Record<string, JsonValue> {
  return Object.fromEntries(names.map((name) => [name, typeof process.env[name] === "string"]));
}

function scalarConfig(config: Record<string, JsonValue>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(config).map(([key, value]) => {
      if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
        throw new Error(`Configuration key "${key}" must be a string, number, or boolean`);
      }
      return [key, String(value)];
    }),
  );
}

interface PagedResult {
  readonly pages: string[];
  readonly totalChars: number;
}

export interface CapabilityHubOptions {
  // Characters per page of a long call result; 0 turns paging off (the old behaviour:
  // one result of up to MAX_CALL_RESULT_CHARS).
  pageChars?: number;
}

// Splits at a line break near the end of each page when there is one, so a page rarely
// ends mid-word or mid-line. Deterministic on purpose: the same text always pages the same
// way, which keeps a replayed conversation byte-identical for the prompt cache.
export function splitPages(text: string, pageChars: number): string[] {
  const pages: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + pageChars, text.length);
    if (end < text.length) {
      const newline = text.lastIndexOf("\n", end);
      if (newline > start + pageChars * 0.8) end = newline + 1;
      const safe = safeEnd(text, end);
      if (safe > start) end = safe;
    }
    pages.push(text.slice(start, end));
    start = end;
  }
  return pages;
}

// A cut between the two halves of a surrogate pair leaves a replacement character on each
// side where one emoji stood, and the model cannot stitch it back together across pages.
function safeEnd(text: string, end: number): number {
  if (end > 0 && end < text.length) {
    const code = text.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) return end - 1;
  }
  return end;
}

// Words, not the whole phrase: "browser click" has to find browser_click. Every word must
// appear; when no tool holds them all, the tools holding some come back best first, because
// an empty answer is a dead end for a small model that worded its query loosely.
export function matchTools<T extends { name: string; description?: string | undefined }>(
  tools: readonly T[],
  query: string | undefined,
): { matched: T[]; partial: boolean } {
  const terms = (query ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return { matched: [...tools], partial: false };
  const scored = tools.map((tool) => {
    const text = `${tool.name} ${tool.description ?? ""}`.toLowerCase();
    return { tool, hits: terms.filter((term) => text.includes(term)).length };
  });
  const every = scored.filter((item) => item.hits === terms.length).map((item) => item.tool);
  if (every.length > 0 || terms.length === 1) return { matched: every, partial: false };
  const some = scored
    .filter((item) => item.hits > 0)
    .sort((left, right) => right.hits - left.hits)
    .map((item) => item.tool);
  return { matched: some, partial: some.length > 0 };
}

// Names close to a mistyped one: substring matches first, then names sharing a word.
export function suggestNames(wanted: string, names: readonly string[], limit = MAX_SUGGESTIONS): string[] {
  const needle = wanted.toLowerCase();
  const words = needle.split(/[^a-z0-9]+/).filter((word) => word.length > 2);
  const scored = names
    .map((name) => {
      const lower = name.toLowerCase();
      const score = lower.includes(needle) || needle.includes(lower)
        ? 2
        : words.some((word) => lower.includes(word)) ? 1 : 0;
      return { name, score };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name));
  return scored.slice(0, limit).map((item) => item.name);
}

export class CapabilityHub {
  readonly repository: CatalogRepository;
  readonly pageChars: number;
  readonly #live = new Map<string, LiveMcp>();
  readonly #starting = new Map<string, Promise<JsonValue>>();
  readonly #paged = new Map<string, PagedResult>();
  #pageSequence = 0;

  constructor(repository: CatalogRepository, options: CapabilityHubOptions = {}) {
    this.repository = repository;
    const pageChars = options.pageChars ?? DEFAULT_PAGE_CHARS;
    if (!Number.isInteger(pageChars) || pageChars < 0) throw new Error("pageChars must be a non-negative integer");
    // A page smaller than its own footer would make paging slower than reading the text.
    this.pageChars = pageChars === 0 ? 0 : Math.max(pageChars, 1_000);
  }

  async execute(input: HubInput, signal: AbortSignal): Promise<CallToolResult> {
    switch (input.action) {
      case "search":
        return this.search(input);
      case "inspect":
        return this.inspect(requireName(input));
      case "status":
        return this.status();
      case "configure":
        return await this.configure(requireName(input), input.config ?? {});
      case "enable":
        if (input.config) await this.configure(requireName(input), input.config);
        return jsonResult(await this.enable(requireName(input)));
      case "disable":
        return jsonResult(await this.disable(requireName(input)));
      case "tools":
        return await this.tools(requireName(input), input.includeSchema ?? false, input.query);
      case "call":
        return await this.call(requireName(input), input.tool, input.arguments ?? {}, signal);
      case "skill.load":
        return await this.loadSkill(requireName(input));
      case "propose":
        return await this.propose(input.entry);
      case "proposals":
        return await this.listProposals();
      case "catalog.reload":
        return await this.reloadCatalog();
      case "page":
        return this.page(input.cursor);
    }
  }

  search(input: Pick<HubInput, "query" | "kind">): CallToolResult {
    const matches = this.repository.search(input.query, input.kind);
    const limited = matches.slice(0, MAX_SEARCH_RESULTS);
    return jsonResult({
      capabilities: limited.map((entry) => publicEntry(entry, this.#live.has(entry.name))),
      total: matches.length,
      truncated: limited.length !== matches.length,
    });
  }

  inspect(name: string): CallToolResult {
    const entry = this.requireEntry(name);
    const base = {
      ...publicEntry(entry, this.#live.has(name)),
      source: entry.source ?? "local catalog",
      permissions: entry.permissions ?? [],
    };
    if (entry.kind === "skill") {
      return jsonResult({ ...base, loadWith: { action: "skill.load", name } });
    }
    const configured = this.repository.configFor(name);
    const transport = entry.transport;
    return jsonResult({
      ...base,
      transport: transport.type,
      configurable: entry.configurable ?? [],
      configuredKeys: Object.keys(configured),
      requiredEnvironment:
        transport.type === "stdio"
          ? environmentStatus(transport.requiredEnv ?? [])
          : environmentStatus(Object.values(transport.headersFromEnv ?? {}).map((header) => header.env)),
      enableWith: { action: "enable", name },
    });
  }

  status(): CallToolResult {
    return jsonResult({
      enabled: [...this.#live.values()].map((live) => ({
        name: live.entry.name,
        tools: live.tools.length,
      })),
      catalogEntries: this.repository.all().length,
      tokenMode: "single-proxy-tool",
    });
  }

  async configure(name: string, config: Record<string, JsonValue>): Promise<CallToolResult> {
    const entry = this.requireMcp(name);
    if (this.#live.has(name)) throw new Error(`Disable "${name}" before changing its configuration`);
    const allowed = new Set(entry.configurable ?? []);
    for (const key of Object.keys(config)) {
      if (!allowed.has(key)) throw new Error(`Configuration key "${key}" is not allowed for "${name}"`);
      if (SECRET_KEY_PATTERN.test(key)) {
        throw new Error(`Secret-like configuration key "${key}" is forbidden; use environment references`);
      }
    }
    scalarConfig(config);
    await this.repository.setConfig(name, config);
    return jsonResult({ configured: name, keys: Object.keys(config) });
  }

  // `tools` and `call` both enable on demand, so two model calls arriving together on
  // a cold capability used to pass the liveness check at the same time, spawn a child
  // process each, and leave every process but the last untracked — invisible to
  // `status` and not reaped by `close()`. Concurrent callers now share one attempt.
  async enable(name: string): Promise<JsonValue> {
    const existing = this.#live.get(name);
    if (existing) return { enabled: name, alreadyEnabled: true, tools: existing.tools.length };
    const pending = this.#starting.get(name);
    if (pending) return await pending;
    const attempt = this.startMcp(name).finally(() => this.#starting.delete(name));
    this.#starting.set(name, attempt);
    return await attempt;
  }

  private async startMcp(name: string): Promise<JsonValue> {
    const entry = this.requireMcp(name);
    if (!entry.trusted) {
      throw new Error(`Capability "${name}" is untrusted. Submit a proposal and approve it outside the MCP first`);
    }
    const config = this.repository.configFor(name);
    scalarConfig(config);
    const client = new Client({ name: "capability-hub", version: "0.1.0" });
    const live: LiveMcp = { entry, client, tools: [] };
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      try {
        live.tools = await this.collectTools(client);
        process.stderr.write(`[capability-hub] ${name}: tool catalog refreshed (${live.tools.length})\n`);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        process.stderr.write(`[capability-hub] ${name}: tool catalog refresh failed, keeping the previous list (${detail})\n`);
      }
    });

    const transport = this.createTransport(entry, config) as unknown as Transport;
    try {
      await client.connect(transport);
      live.tools = await this.collectTools(client);
      this.#live.set(name, live);
      // Returning the whole tool list here made the documented workflow pay for the
      // same list twice, since the next step is "tools". Report the count instead.
      return {
        enabled: name,
        tools: live.tools.length,
        nextStep: { action: "tools", name },
      };
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
  }

  async disable(name: string): Promise<JsonValue> {
    // A start still in flight has not reached the live map yet, so reporting
    // wasEnabled:false here told the model nothing needed stopping while the child went
    // on to start and stay running.
    const starting = this.#starting.get(name);
    if (starting) await starting.catch(() => undefined);
    const live = this.#live.get(name);
    if (!live) return { disabled: name, wasEnabled: false };
    this.#live.delete(name);
    // The entry is already gone from the live map, so a child that dies while closing must
    // not turn a successful stop into an error the model then tries to retry.
    await live.client.close().catch(() => undefined);
    return { disabled: name, wasEnabled: true };
  }

  async tools(name: string, includeSchema: boolean, query?: string): Promise<CallToolResult> {
    if (!this.#live.has(name)) await this.enable(name);
    const live = this.#live.get(name);
    if (!live) throw new Error(`Failed to enable "${name}"`);
    // A server with a hundred tools would otherwise dump all of them into context.
    // The query narrows the list first, and the cap bounds the worst case.
    const { matched, partial } = matchTools(live.tools, query);
    const limited = matched.slice(0, MAX_TOOL_RESULTS);
    // An empty list has two very different causes that used to look identical: a server
    // that published nothing, and a query that matched nothing. The first is the more
    // confusing one — a capability whose backing application is not running starts
    // cleanly and then exposes zero tools, so the caller sees `total: 0` and no reason.
    // Observed against a Unity MCP with the editor closed. Naming the cause costs a dozen
    // tokens and is the difference between a retry and a dead end.
    const note =
      live.tools.length === 0
        ? `"${name}" started but published no tools. Its backing application is probably not running; start it and call this action again.`
        : matched.length === 0
          ? `No tool on "${name}" matched ${JSON.stringify(query ?? "")}. Call this action without a query to see all ${String(live.tools.length)}.`
          : partial
            ? `No tool on "${name}" matched every word of ${JSON.stringify(query ?? "")}; these match some of them, best first.`
            : undefined;
    return jsonResult({
      server: name,
      tools: limited.map((tool) => ({
        name: tool.name,
        description: truncate(tool.description ?? ""),
        ...(includeSchema ? { inputSchema: tool.inputSchema as JsonValue } : {}),
      })),
      total: live.tools.length,
      matched: matched.length,
      truncated: limited.length !== matched.length,
      schemasIncluded: includeSchema,
      ...(note === undefined ? {} : { note }),
    });
  }

  async call(
    name: string,
    toolName: string | undefined,
    args: Record<string, JsonValue>,
    signal: AbortSignal,
  ): Promise<CallToolResult> {
    if (!toolName) throw new Error('Action "call" requires tool');
    if (!this.#live.has(name)) await this.enable(name);
    const live = this.#live.get(name);
    if (!live) throw new Error(`Failed to enable "${name}"`);
    if (!live.tools.some((tool) => tool.name === toolName)) {
      // Listing the near misses saves the model a "tools" round trip for the common case
      // of a slightly wrong name (web_fetch for web_action, a missing prefix, a typo).
      const near = suggestNames(toolName, live.tools.map((tool) => tool.name));
      const hint = near.length > 0
        ? `did you mean ${near.map((item) => JSON.stringify(item)).join(", ")}?`
        : `its tools are ${live.tools.slice(0, MAX_SUGGESTIONS * 2).map((tool) => JSON.stringify(tool.name)).join(", ")}`;
      throw new Error(`MCP "${name}" has no tool "${toolName}"; ${hint}`);
    }
    let result;
    try {
      result = await live.client.callTool({ name: toolName, arguments: args }, undefined, { signal });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      // Not every failure means the child died, and tearing a healthy server down on a
      // cancelled call or a local serialisation error is a self-inflicted restart loop.
      if (!this.#live.has(name)) {
        throw new Error(`MCP "${name}" was disabled while "${toolName}" was running; call action "enable" and retry`);
      }
      if (signal.aborted) {
        throw new Error(`Call "${toolName}" on "${name}" was cancelled (${detail}); the server is still enabled`);
      }
      if (!TRANSPORT_FAILURE.test(detail)) {
        // The child answered, or the request never left this process. Either way it is
        // still usable, and the model should see the real reason rather than a restart.
        throw new Error(`MCP "${name}" rejected "${toolName}": ${detail}`);
      }
      this.#live.delete(name);
      await live.client.close().catch(() => undefined);
      throw new Error(`MCP "${name}" stopped responding during "${toolName}" (${detail}); call action "enable" to restart it`);
    }
    if (!("content" in result) || !Array.isArray(result.content)) {
      return this.pageResult(
        textResult(truncate(JSON.stringify("toolResult" in result ? result.toolResult : result), MAX_CALL_RESULT_CHARS)),
      );
    }
    return this.pageResult(this.capResult(result as CallToolResult));
  }

  // A result whose text fits one page goes through untouched. A longer one is cut into
  // pages: the first is returned now with a footer naming the cursor of the next, and the
  // rest wait in memory for action "page". Images and other non-text parts stay on page 1.
  private pageResult(result: CallToolResult): CallToolResult {
    if (this.pageChars === 0) return result;
    const isText = (part: CallToolResult["content"][number]): part is { type: "text"; text: string } =>
      part.type === "text" && typeof (part as { text?: unknown }).text === "string";
    const text = result.content.filter(isText).map((part) => part.text).join("\n");
    if (text.length <= this.pageChars) return result;
    const pages = splitPages(text, this.pageChars);
    this.#pageSequence += 1;
    const id = `r${String(this.#pageSequence)}`;
    this.#paged.set(id, { pages, totalChars: text.length });
    while (this.#paged.size > MAX_PAGED_RESULTS) {
      const oldest = this.#paged.keys().next().value;
      if (oldest === undefined) break;
      this.#paged.delete(oldest);
    }
    const others = result.content.filter((part) => !isText(part));
    const first = this.pageText(id, 1);
    return {
      ...(result.isError === undefined ? {} : { isError: result.isError }),
      content: [{ type: "text", text: first }, ...others],
      // OpenCode renders structuredContent only. Without `text` here every paged result
      // reached it as a bare cursor, with the page itself missing.
      structuredContent: { paged: true, cursor: `${id}:2`, pages: pages.length, totalChars: text.length, text: first },
    };
  }

  private pageText(id: string, number: number): string {
    const paged = this.#paged.get(id);
    if (!paged) throw new Error(`Unknown result "${id}"`);
    const body = paged.pages[number - 1] ?? "";
    const footer = number < paged.pages.length
      ? `[capability_hub: page ${String(number)} of ${String(paged.pages.length)}, ${String(paged.totalChars)} chars in all. ` +
        `Next page: {"action":"page","cursor":"${id}:${String(number + 1)}"}]`
      : `[capability_hub: page ${String(number)} of ${String(paged.pages.length)}, the last one.]`;
    // Always exactly one separator, so the page text is everything before the last line.
    return `${body}\n${footer}`;
  }

  page(cursor: string | undefined): CallToolResult {
    if (!cursor) throw new Error('Action "page" requires cursor, copied from the last line of a paged result');
    const match = /^(r\d+):(\d+)$/.exec(cursor.trim());
    if (!match) throw new Error(`Cursor "${cursor}" is not of the form r<number>:<page>, as printed in a result footer`);
    const id = match[1] as string;
    const number = Number(match[2]);
    const paged = this.#paged.get(id);
    if (!paged) {
      throw new Error(
        `Result "${id}" is no longer held (the hub keeps its last ${String(MAX_PAGED_RESULTS)} paged results until it restarts); repeat the call`,
      );
    }
    if (number < 1 || number > paged.pages.length) {
      throw new Error(`Result "${id}" has pages 1 to ${String(paged.pages.length)}; page ${String(number)} does not exist`);
    }
    const pageText = this.pageText(id, number);
    return textResult(pageText, {
      cursor: number < paged.pages.length ? `${id}:${String(number + 1)}` : null,
      page: number,
      pages: paged.pages.length,
      totalChars: paged.totalChars,
      text: pageText,
    });
  }

  // A child's answer went straight through: one measured reply was 8.4 MB, about two
  // million tokens, from the very tool whose purpose is a small context.
  private capResult(result: CallToolResult): CallToolResult {
    let budget = MAX_CALL_RESULT_CHARS;
    let truncated = false;
    const content = result.content.map((part) => {
      if (part.type !== "text" || typeof part.text !== "string") return part;
      if (budget <= 0) {
        truncated = true;
        return { ...part, text: "" };
      }
      if (part.text.length <= budget) {
        budget -= part.text.length;
        return part;
      }
      const text = part.text.slice(0, safeEnd(part.text, budget));
      budget = 0;
      truncated = true;
      return { ...part, text };
    });
    if (!truncated) return result;
    return {
      ...result,
      content,
      structuredContent: { ...(result.structuredContent ?? {}), truncated: true, limitChars: MAX_CALL_RESULT_CHARS },
    };
  }

  async loadSkill(name: string): Promise<CallToolResult> {
    const entry = this.requireSkill(name);
    const skillPath = await this.repository.resolveTrustedSkillPath(entry);
    // Checking after the read defeated the point: a 768 MB file pushed RSS past 600 MB and
    // failed with V8's "Invalid string length" instead of the limit message. stat runs on
    // the already-realpath'd path, so this does not widen the TOCTOU window.
    const { size } = await stat(skillPath);
    if (size > MAX_SKILL_BYTES) {
      throw new Error(`Skill "${name}" exceeds the ${MAX_SKILL_BYTES}-byte safety limit`);
    }
    const content = await readFile(skillPath, "utf8");
    return textResult(
      `<skill_content name="${entry.name}">\n<skill_instructions>\n${content}\n</skill_instructions>\n</skill_content>`,
      // Clients differ in what they surface: DSH renders content.text, while OpenCode reads
      // structuredContent only. Without the body here a skill arrives as a 64-character
      // metadata stub. The duplication costs tokens only on an explicit skill.load.
      { name: entry.name, source: entry.source ?? skillPath, instructions: content },
    );
  }

  async propose(entry: CapabilityEntry | undefined): Promise<CallToolResult> {
    if (!entry) throw new Error('Action "propose" requires entry');
    const proposal = await this.repository.saveProposal(entry);
    return jsonResult({
      proposal: proposal as unknown as JsonValue,
      executable: false,
      nextStep: `A human must review and run capability-hub-admin approve ${proposal.id} --catalog "${this.repository.catalogPath}" --state "${this.repository.stateDir}" --yes`,
    });
  }

  // The full documents are for the human reviewing them on disk. Returning every one in
  // full measured a 170 MB payload after a proposal loop — a context bomb by any measure.
  async listProposals(): Promise<CallToolResult> {
    const all = await this.repository.proposals();
    const limited = all.slice(0, MAX_PROPOSAL_RESULTS);
    return jsonResult({
      proposals: limited.map((proposal) => ({
        id: proposal.id,
        createdAt: proposal.createdAt,
        kind: proposal.entry.kind,
        name: proposal.entry.name,
        description: proposal.entry.description.slice(0, MAX_FIELD_CHARS),
      })),
      total: all.length,
      truncated: limited.length !== all.length,
    });
  }

  // Removing an entry, or clearing its trusted flag, is how an operator revokes a
  // compromised server. That did nothing while it was running: the live map held its own
  // reference to the old entry, so the revoked capability kept answering calls.
  async reloadCatalog(): Promise<CallToolResult> {
    await this.repository.load();
    const stopped: string[] = [];
    for (const [name, live] of [...this.#live]) {
      const fresh = this.repository.get(name);
      const revoked = !fresh
        || fresh.kind !== "mcp"
        || !fresh.trusted
        || JSON.stringify(fresh.transport) !== JSON.stringify(live.entry.transport);
      if (revoked) {
        stopped.push(name);
        await this.disable(name);
      }
    }
    return jsonResult({ reloaded: true, entries: this.repository.all().length, stopped });
  }

  async close(): Promise<void> {
    // A start still in flight would finish after this and leave an untracked child,
    // so settle those first and close whatever they registered.
    await Promise.allSettled([...this.#starting.values()]);
    const clients = [...this.#live.values()];
    this.#live.clear();
    this.#starting.clear();
    this.#paged.clear();
    await Promise.allSettled(clients.map(async (live) => await live.client.close()));
  }

  private requireEntry(name: string): CapabilityEntry {
    const entry = this.repository.get(name);
    if (!entry) throw new Error(`Unknown capability "${name}"`);
    return entry;
  }

  private requireMcp(name: string): McpCapabilityEntry {
    const entry = this.requireEntry(name);
    if (entry.kind !== "mcp") throw new Error(`Capability "${name}" is a skill, not an MCP server`);
    return entry;
  }

  private requireSkill(name: string): SkillCapabilityEntry {
    const entry = this.requireEntry(name);
    if (entry.kind !== "skill") throw new Error(`Capability "${name}" is an MCP server, not a skill`);
    return entry;
  }

  private createTransport(entry: McpCapabilityEntry, config: Record<string, JsonValue>) {
    const transport = entry.transport;
    if (transport.type === "stdio") {
      const missing = (transport.requiredEnv ?? []).filter((name) => !process.env[name]);
      if (missing.length > 0) throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
      const env = {
        ...getDefaultEnvironment(),
        ...Object.fromEntries((transport.requiredEnv ?? []).map((name) => [name, process.env[name] as string])),
        ...Object.fromEntries(
          Object.entries(transport.env ?? {}).map(([key, value]) => {
            if (LOADER_ENV.test(key)) {
              throw new Error(`Environment variable "${key}" can load code into the child and cannot be set from a catalog entry`);
            }
            return [key, this.repository.resolveTemplate(value, config)];
          }),
        ),
      };
      return new StdioClientTransport({
        command: this.repository.resolveExecutableTemplate(transport.command),
        args: (transport.args ?? []).map((value) => this.repository.resolveTemplate(value, config)),
        env,
        ...(transport.cwd
          ? { cwd: this.repository.resolveExecutableTemplate(transport.cwd) }
          : {}),
        stderr: "inherit",
      });
    }

    const headers = Object.fromEntries(
      Object.entries(transport.headersFromEnv ?? {}).map(([header, definition]) => {
        const value = process.env[definition.env];
        if (!value) throw new Error(`Missing required environment variable: ${definition.env}`);
        return [header, `${definition.prefix ?? ""}${value}`];
      }),
    );
    // The template is resolved from model-supplied configuration, so the result is
    // re-checked against the origin the catalog declared. Following a redirect would let a
    // compromised endpoint bounce the request — and any non-Authorization header defined
    // in headersFromEnv — into an internal service, so redirects are refused outright.
    const resolvedUrl = new URL(this.repository.resolveTemplate(transport.url, config));
    const declaredOrigin = new URL(transport.url.replace(/\$\{[^}]+\}/g, "placeholder")).origin;
    if (resolvedUrl.origin !== declaredOrigin) {
      throw new Error(`Configuration changed the transport origin for this capability to ${resolvedUrl.origin}`);
    }
    return new StreamableHTTPClientTransport(resolvedUrl, {
      requestInit: { headers, redirect: "error" },
    });
  }

  private async collectTools(client: Client): Promise<Tool[]> {
    const tools: Tool[] = [];
    let cursor: string | undefined;
    do {
      let page;
      try {
        page = await client.listTools(cursor ? { cursor } : undefined);
      } catch (error) {
        // A server that exposes only prompts or resources never registers a tools/list
        // handler and answers -32601. That is a legitimate MCP server, not a broken one,
        // and letting the raw JSON-RPC error escape turned `enable` into an unexplained
        // failure. Zero tools is the honest answer; `tools` then says why.
        if (isMethodNotFound(error)) return tools;
        throw error;
      }
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
  }
}
