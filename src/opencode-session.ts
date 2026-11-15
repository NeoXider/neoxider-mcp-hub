import type { MessagePart } from "./opencode-recovery.js";
import { declaredHubTool, recoveryMessage, strandedHubCalls } from "./opencode-recovery.js";

// The OpenCode side of the recovery: read the stopped session, decide, add one message.
// Kept apart from opencode-plugin.ts because OpenCode calls every function a plugin
// module exports, and these are not plugin factories.


interface Described<T> {
  data?: T;
}

interface SessionInfo {
  parentID?: string;
}

interface MessageInfo {
  id: string;
  role: string;
  time?: { created?: number; completed?: number };
  error?: unknown;
  providerID?: string;
  modelID?: string;
  mode?: string;
}

interface StoredMessage {
  info: MessageInfo;
  parts: MessagePart[];
}

export interface OpenCodeClientLike {
  session: {
    get(options: { path: { id: string } }): Promise<Described<SessionInfo> | SessionInfo>;
    messages(options: { path: { id: string }; query?: { limit?: number } }): Promise<Described<StoredMessage[]> | StoredMessage[]>;
    promptAsync(options: {
      path: { id: string };
      body: {
        parts: { type: "text"; text: string }[];
        model?: { providerID: string; modelID: string };
        agent?: string;
      };
    }): Promise<unknown>;
  };
  tool?: { ids(): Promise<Described<string[]> | string[]> };
}

// Consecutive recoveries per session. A model that writes the call as text again after
// being told twice will not be argued with a third time.
export const MAX_RECOVERIES = 2;

function unwrap<T>(value: Described<T> | T): T | undefined {
  return value !== null && typeof value === "object" && "data" in (value as object) ? (value as Described<T>).data : (value as T);
}

const isStop = (event: { type: string; properties?: { status?: { type?: string } } }): boolean =>
  event.type === "session.idle" || (event.type === "session.status" && event.properties?.status?.type === "idle");

export interface Recovery {
  handle(event: { type: string; properties?: { sessionID?: string; status?: { type?: string } } }): Promise<void>;
}

export function createRecovery(client: OpenCodeClientLike, trace: (line: string) => void = () => {}): Recovery {
  const nudged = new Map<string, { messageID: string; count: number }>();
  const running = new Set<string>();

  async function recover(sessionID: string): Promise<void> {
    const messages = unwrap(await client.session.messages({ path: { id: sessionID }, query: { limit: 20 } })) ?? [];
    const ordered = [...messages].sort((a, b) => (a.info.time?.created ?? 0) - (b.info.time?.created ?? 0));
    const latest = ordered[ordered.length - 1];
    // A user message last means a new turn already started; an error or a missing
    // completion time means the user aborted or the run is not over.
    if (latest === undefined || latest.info.role !== "assistant") return trace(`skip ${sessionID}: last message is ${latest?.info.role ?? "missing"}`);
    if (latest.info.error !== undefined || latest.info.time?.completed === undefined) {
      return trace(`skip ${sessionID}: last reply is not a finished turn`);
    }

    const calls = strandedHubCalls(latest.parts);
    const previous = nudged.get(sessionID);
    if (calls === undefined) {
      nudged.delete(sessionID);
      return trace(`skip ${sessionID}: no written hub call at the end of ${latest.info.id}`);
    }
    if (previous?.messageID === latest.info.id) return;
    if ((previous?.count ?? 0) >= MAX_RECOVERIES) {
      trace(`give up ${sessionID}: ${MAX_RECOVERIES} recoveries did not help`);
      return;
    }

    const session = unwrap(await client.session.get({ path: { id: sessionID } }));
    if (session?.parentID !== undefined) return trace(`skip ${sessionID}: subagent`);

    let ids: string[] | undefined;
    try {
      ids = client.tool === undefined ? undefined : unwrap(await client.tool.ids());
    } catch {
      ids = undefined;
    }
    const toolName = declaredHubTool(ids);

    nudged.set(sessionID, { messageID: latest.info.id, count: (previous?.count ?? 0) + 1 });
    trace(`recover ${sessionID} message ${latest.info.id} as ${toolName}`);
    const { providerID, modelID, mode } = latest.info;
    await client.session.promptAsync({
      path: { id: sessionID },
      body: {
        parts: [{ type: "text", text: recoveryMessage(calls, toolName) }],
        ...(providerID && modelID ? { model: { providerID, modelID } } : {}),
        ...(mode ? { agent: mode } : {}),
      },
    });
  }

  return {
    async handle(event) {
      if (!isStop(event)) return;
      const sessionID = event.properties?.sessionID;
      if (!sessionID || running.has(sessionID)) return;
      trace(`stop ${event.type} ${sessionID}`);
      running.add(sessionID);
      try {
        await recover(sessionID);
      } catch (error) {
        trace(`recovery failed for ${sessionID}: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        running.delete(sessionID);
      }
    },
  };
}
