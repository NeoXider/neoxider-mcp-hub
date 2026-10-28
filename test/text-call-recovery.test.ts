import assert from "node:assert/strict";
import test from "node:test";
import type { StreamChunk } from "../src/text-call-recovery.js";
import { isHubToolName, parseTrailingCalls, recoverTextCalls } from "../src/text-call-recovery.js";

const TYPES = {
  action: "string",
  name: "string",
  tool: "string",
  arguments: "object",
  includeSchema: "boolean",
};

// The call a Strata-served model wrote after the hub stopped being an MCP row.
const WRITTEN = [
  "Let me fetch it through the hub.",
  "<tool_call>",
  "<function=mcp__capability_hub>",
  "<parameter=action>",
  "call",
  "</parameter>",
  "<parameter=name>",
  "web-search-neo",
  "</parameter>",
  "<parameter=tool>",
  "web_fetch",
  "</parameter>",
  "<parameter=arguments>",
  '{"url": "https://example.com"}',
  "</parameter>",
  "</function>",
  "</tool_call>",
].join("\n");

async function* stream(...chunks: StreamChunk[]): AsyncGenerator<StreamChunk> {
  yield* chunks;
}

async function collect(source: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const chunk of source) out.push(chunk);
  return out;
}

function textReply(text: string, finish: StreamChunk = { type: "finish", reason: { kind: "stop" }, replayState: { blocks: [{ type: "text" }] } }): StreamChunk[] {
  return [
    { type: "block-start", index: 0, blockType: "text" },
    { type: "text-delta", index: 0, text: text.slice(0, 20) },
    { type: "text-delta", index: 0, text: text.slice(20) },
    { type: "block-end", index: 0, block: { type: "text", text } },
    { type: "usage", usage: { input: 1, output: 1 } },
    finish,
  ];
}

test("every spelling a model has used for the hub tool is recognized", () => {
  for (const name of [
    "capability_hub",
    "capability-hub",
    "mcp__capability_hub",
    "mcp__capability_hub__capability_hub",
    "mcp__capability-hub__capability_hub",
    "MCP__Capability-Hub__capability_hub",
  ]) {
    assert.equal(isHubToolName(name), true, name);
  }
  for (const name of ["pwsh", "web_fetch", "mcp__web_search_neo__web_fetch", "capabilityhub"]) {
    assert.equal(isHubToolName(name), false, name);
  }
});

test("a trailing XML call parses with values typed by the tool schema", () => {
  const parsed = parseTrailingCalls(`${WRITTEN}\n<tool_call>\n<function=capability_hub>\n<parameter=action>\ntools\n</parameter>\n<parameter=includeSchema>\ntrue\n</parameter>\n</function>\n</tool_call>\n`, TYPES);
  assert.deepEqual(parsed, {
    prose: "Let me fetch it through the hub.",
    calls: [
      {
        name: "mcp__capability_hub",
        arguments: { action: "call", name: "web-search-neo", tool: "web_fetch", arguments: { url: "https://example.com" } },
      },
      { name: "capability_hub", arguments: { action: "tools", includeSchema: true } },
    ],
  });
});

test("a JSON-style call and a call missing only its closing tag parse too", () => {
  assert.deepEqual(parseTrailingCalls('<tool_call>\n{"name": "capability_hub", "arguments": {"action": "status"}}\n</tool_call>', TYPES), {
    prose: "",
    calls: [{ name: "capability_hub", arguments: { action: "status" } }],
  });
  assert.deepEqual(parseTrailingCalls("<tool_call>\n<function=capability_hub>\n<parameter=action>\nstatus\n</parameter>\n</function>", TYPES), {
    prose: "",
    calls: [{ name: "capability_hub", arguments: { action: "status" } }],
  });
});

test("text that only quotes or cuts off a call is not treated as one", () => {
  assert.equal(parseTrailingCalls(`${WRITTEN}\nThat is how a call looks.`, TYPES), undefined);
  assert.equal(parseTrailingCalls(`Example:\n\`\`\`\n${WRITTEN}`, TYPES), undefined);
  assert.equal(parseTrailingCalls("<tool_call>\n<function=capability_hub>\n<parameter=action>\nstat", TYPES), undefined);
  assert.equal(parseTrailingCalls("<tool_call>\n<function=capability_hub>\nnot a parameter\n</function>", TYPES), undefined);
  assert.equal(parseTrailingCalls("No call here.", TYPES), undefined);
});

test("a written hub call becomes a real capability_hub call and the text keeps only the prose", async () => {
  const out = await collect(recoverTextCalls(stream(...textReply(WRITTEN)), TYPES, () => "call_1"));
  assert.deepEqual(out, [
    { type: "block-start", index: 0, blockType: "text" },
    { type: "text-delta", index: 0, text: WRITTEN.slice(0, 20) },
    { type: "text-delta", index: 0, text: WRITTEN.slice(20) },
    { type: "usage", usage: { input: 1, output: 1 } },
    { type: "block-end", index: 0, block: { type: "text", text: "Let me fetch it through the hub." } },
    { type: "block-start", index: 1, blockType: "tool-call" },
    {
      type: "tool-call-delta",
      index: 1,
      id: "call_1",
      name: "capability_hub",
      argumentsDelta: '{"action":"call","name":"web-search-neo","tool":"web_fetch","arguments":{"url":"https://example.com"}}',
    },
    {
      type: "block-end",
      index: 1,
      block: {
        type: "tool-call",
        id: "call_1",
        name: "capability_hub",
        arguments: '{"action":"call","name":"web-search-neo","tool":"web_fetch","arguments":{"url":"https://example.com"}}',
      },
    },
    { type: "finish", reason: { kind: "tool-calls" } },
  ]);
});

test("a reply is passed on unchanged when there is nothing to recover", async () => {
  const cases: StreamChunk[][] = [
    textReply("Plain answer."),
    textReply(WRITTEN.replace("mcp__capability_hub", "web_fetch")),
    textReply(WRITTEN, { type: "finish", reason: { kind: "max-tokens" } }),
    [
      { type: "text-delta", index: 0, text: WRITTEN },
      { type: "block-end", index: 0, block: { type: "text", text: WRITTEN } },
      { type: "block-start", index: 1, blockType: "tool-call" },
      { type: "tool-call-delta", index: 1, id: "real", name: "capability_hub", argumentsDelta: "{}" },
      { type: "block-end", index: 1, block: { type: "tool-call", id: "real", name: "capability_hub", arguments: "{}" } },
      { type: "finish", reason: { kind: "tool-calls" } },
    ],
  ];
  for (const chunks of cases) {
    const out = await collect(recoverTextCalls(stream(...chunks), TYPES));
    // Held text ends come out later, but every chunk survives and each text keeps its text.
    assert.deepEqual([...out].sort(byJson), [...chunks].sort(byJson));
  }
});

function byJson(left: StreamChunk, right: StreamChunk): number {
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
}
