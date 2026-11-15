import { appendFileSync } from "node:fs";
import type { OpenCodeClientLike, Recovery } from "./opencode-session.js";
import { createRecovery } from "./opencode-session.js";

// An OpenCode plugin that answers a reply ending in a written hub call (see
// opencode-recovery.ts for why a message is the only thing OpenCode lets it do). Load it
// from the opencode config: "plugin": ["file:///<checkout>/dist/src/opencode-plugin.js"].
// CAPABILITY_HUB_TEXT_RECOVERY=0 switches it off; CAPABILITY_HUB_TEXT_RECOVERY_TRACE=<file>
// appends what it decides, which is also how to confirm that OpenCode loaded it.
//
// OpenCode 1.18 loads a plugin module from its default export, { id, server }; a module
// that only exports a bare factory fails with "Plugin must export a default definition".
// The named factory stays exported for older loaders and for tests, and it is the only
// function this module exports, because an older OpenCode calls every function it finds.
export const CapabilityHubTextCallRecovery = async ({ client }: { client: OpenCodeClientLike }) => {
  if (process.env.CAPABILITY_HUB_TEXT_RECOVERY === "0") return {};
  const traceFile = process.env.CAPABILITY_HUB_TEXT_RECOVERY_TRACE;
  const trace = (line: string): void => {
    if (!traceFile) return;
    try {
      appendFileSync(traceFile, `${new Date().toISOString()} ${line}\n`);
    } catch {
      // Tracing must never break a run.
    }
  };
  trace("loaded");
  const recovery = createRecovery(client, trace);
  return {
    event: async ({ event }: { event: Parameters<Recovery["handle"]>[0] }) => recovery.handle(event),
  };
};

export default { id: "capability-hub-text-call-recovery", server: CapabilityHubTextCallRecovery };
