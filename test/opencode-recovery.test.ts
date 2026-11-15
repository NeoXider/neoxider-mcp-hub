import assert from "node:assert/strict";
import test from "node:test";
import { CapabilityHubTextCallRecovery } from "../src/opencode-plugin.js";
import { declaredHubTool, recoveryMessage, strandedHubCalls } from "../src/opencode-recovery.js";
import type { OpenCodeClientLike } from "../src/opencode-session.js";
import { MAX_RECOVERIES, createRecovery } from "../src/opencode-session.js";

// The reply from the screenshot: a Strata-served model wrote the bare name.
const WRITTEN = [
  "<tool_call>",
  "<function=capability_hub>",
  "<parameter=action>",
  "call",
  "</parameter>",
  "<parameter=name>",
  "web-search-neo",
  "</parameter>",
  "<parameter=tool>",
  "web_action",
  "</parameter>",
  "<parameter=arguments>",
  '{"actions": {"action": "screenshot", "mode": "viewport"}}',
  "</parameter>",
  "</function>",
  "</tool_call>",
].join("\n");

const stop = (sessionID = "ses_1") => ({ type: "session.idle", properties: { sessionID } });

function message(id: string, parts: { type: string; text?: string }[], overrides: Record<string, unknown> = {}) {
  return {
    info: {
      id,
      role: "assistant",
      time: { created: Number(id.replace(/\D/g, "")), completed: Number(id.replace(/\D/g, "")) + 1 },
      providerID: "strata-local",
      modelID: "qwen3.8-flash",
      mode: "build",
      ...overrides,
    },
    parts,
  };
}

function fakeClient(messages: ReturnType<typeof message>[], options: { ids?: string[]; parentID?: string } = {}) {
  const prompts: { path: { id: string }; body: { parts: { text: string }[]; model?: unknown; agent?: string } }[] = [];
  const client = {
    session: {
      get: async () => ({ data: options.parentID === undefined ? {} : { parentID: options.parentID } }),
      messages: async () => ({ data: messages }),
      promptAsync: async (request: (typeof prompts)[number]) => {
        prompts.push(request);
      },
    },
    tool: { ids: async () => ({ data: options.ids ?? ["bash", "capability_hub_capability_hub"] }) },
  } as unknown as OpenCodeClientLike;
  return { client, prompts };
}

test("a reply that ends in a written hub call is found, bookkeeping parts after it are ignored", () => {
  const calls = strandedHubCalls([
    { type: "step-start" },
    { type: "reasoning", text: "thinking" },
    { type: "text", text: WRITTEN },
    { type: "step-finish" },
  ]);
  assert.deepEqual(calls, [
    {
      name: "capability_hub",
      arguments: { action: "call", name: "web-search-neo", tool: "web_action", arguments: { actions: { action: "screenshot", mode: "viewport" } } },
    },
  ]);
});

test("replies that are not a stranded hub call are left alone", () => {
  assert.equal(strandedHubCalls([{ type: "text", text: "Done, nothing to run." }]), undefined);
  assert.equal(strandedHubCalls([{ type: "text", text: WRITTEN }, { type: "tool" }]), undefined, "a real call came after the text");
  assert.equal(strandedHubCalls([{ type: "text", text: WRITTEN.replace("capability_hub", "pwsh") }]), undefined, "another tool");
  assert.equal(strandedHubCalls([{ type: "text", text: `\`\`\`\n${WRITTEN}\n\`\`\`` }]), undefined, "a quoted example");
  assert.equal(strandedHubCalls([{ type: "text", text: WRITTEN.replace("</function>\n</tool_call>", "") }]), undefined, "cut off");
  assert.equal(strandedHubCalls([]), undefined);
});

test("the message names the declared tool and repeats the arguments", () => {
  const text = recoveryMessage([{ name: "capability_hub", arguments: { action: "tools", name: "web-search-neo" } }]);
  assert.match(text, /call the tool named exactly `capability_hub_capability_hub`/);
  assert.match(text, /\{"action":"tools","name":"web-search-neo"\}/);
  const two = recoveryMessage([
    { name: "capability_hub", arguments: { action: "status" } },
    { name: "capability_hub", arguments: { action: "page" } },
  ]);
  assert.match(two, /1\. \{"action":"status"\}\n2\. \{"action":"page"\}/);
});

test("the declared tool is read from the ids OpenCode lists", () => {
  assert.equal(declaredHubTool(["bash", "capability_hub_capability_hub"]), "capability_hub_capability_hub");
  assert.equal(declaredHubTool(["bash", "capability_hub"]), "capability_hub");
  // The ids call lists OpenCode's own tools, not MCP ones, so a miss falls back to the usual name.
  assert.equal(declaredHubTool(["bash", "read"]), "capability_hub_capability_hub");
  assert.equal(declaredHubTool(undefined), "capability_hub_capability_hub");
});

test("a stopped session whose last reply is a written call gets one message with the model and agent", async () => {
  const { client, prompts } = fakeClient([message("m1", [{ type: "text", text: "hi" }]), message("m2", [{ type: "text", text: WRITTEN }])]);
  const recovery = createRecovery(client);
  await recovery.handle(stop());
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0]?.path.id, "ses_1");
  assert.deepEqual(prompts[0]?.body.model, { providerID: "strata-local", modelID: "qwen3.8-flash" });
  assert.equal(prompts[0]?.body.agent, "build");
  assert.match(prompts[0]?.body.parts[0]?.text ?? "", /capability_hub_capability_hub/);
  // session.status and session.idle both arrive for one stop: the same message is not answered twice.
  await recovery.handle({ type: "session.status", properties: { sessionID: "ses_1", status: { type: "idle" } } });
  assert.equal(prompts.length, 1);
});

test("nothing is sent for a normal reply, a running turn, an abort or a subagent", async () => {
  const cases: [string, ReturnType<typeof fakeClient>][] = [
    ["normal reply", fakeClient([message("m2", [{ type: "text", text: "all done" }])])],
    ["user spoke last", fakeClient([message("m2", [{ type: "text", text: WRITTEN }]), message("m3", [], { role: "user" })])],
    ["still running", fakeClient([message("m2", [{ type: "text", text: WRITTEN }], { time: { created: 2 } })])],
    ["aborted", fakeClient([message("m2", [{ type: "text", text: WRITTEN }], { error: { name: "MessageAbortedError" } })])],
    ["subagent", fakeClient([message("m2", [{ type: "text", text: WRITTEN }])], { parentID: "ses_0" })],
  ];
  for (const [label, { client, prompts }] of cases) {
    await createRecovery(client).handle(stop());
    assert.equal(prompts.length, 0, label);
  }
  const { client, prompts } = fakeClient([message("m2", [{ type: "text", text: WRITTEN }])]);
  await createRecovery(client).handle({ type: "message.updated", properties: {} });
  await createRecovery(client).handle({ type: "session.idle" });
  assert.equal(prompts.length, 0, "not a stop for a session");
});

test("a model that keeps writing the call as text is answered at most twice", async () => {
  const history = [message("m1", [{ type: "text", text: WRITTEN }])];
  const { client, prompts } = fakeClient(history);
  const recovery = createRecovery(client);
  for (let turn = 2; turn <= 5; turn++) {
    await recovery.handle(stop());
    history.push(message(`m${turn}`, [{ type: "text", text: WRITTEN }]));
  }
  assert.equal(prompts.length, MAX_RECOVERIES);
  // A good reply resets the count.
  history.push(message("m9", [{ type: "text", text: "fine now" }]));
  await recovery.handle(stop());
  history.push(message("m10", [{ type: "text", text: WRITTEN }]));
  await recovery.handle(stop());
  assert.equal(prompts.length, MAX_RECOVERIES + 1);
});

test("a failing OpenCode call does not break the plugin, and the plugin can be switched off", async () => {
  const broken = {
    session: {
      get: async () => ({}),
      messages: async () => {
        throw new Error("server gone");
      },
      promptAsync: async () => undefined,
    },
  } as unknown as OpenCodeClientLike;
  await createRecovery(broken).handle(stop());

  const { client, prompts } = fakeClient([message("m2", [{ type: "text", text: WRITTEN }])]);
  const hooks = (await CapabilityHubTextCallRecovery({ client })) as { event?: (input: { event: unknown }) => Promise<void> };
  await hooks.event?.({ event: stop() });
  assert.equal(prompts.length, 1);

  process.env.CAPABILITY_HUB_TEXT_RECOVERY = "0";
  try {
    assert.deepEqual(await CapabilityHubTextCallRecovery({ client }), {});
  } finally {
    delete process.env.CAPABILITY_HUB_TEXT_RECOVERY;
  }
});
