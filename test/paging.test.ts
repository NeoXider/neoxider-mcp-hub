import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CatalogRepository } from "../src/catalog.js";
import { CapabilityHub, DEFAULT_PAGE_CHARS, splitPages, suggestNames } from "../src/manager.js";

// DeepSeek Harness's tool-result pruner rewrites results longer than this many characters,
// which breaks a local server's prompt cache from that message on. Pages must stay below it.
const DSH_PRUNER_THRESHOLD_CHARS = 8_192;

function text(result: Awaited<ReturnType<CapabilityHub["execute"]>>): string {
  const block = result.content[0];
  assert.equal(block?.type, "text");
  return block.type === "text" ? block.text : "";
}

async function echoHub(pageChars?: number): Promise<CapabilityHub> {
  const root = await mkdtemp(path.join(os.tmpdir(), "capability-hub-paging-"));
  const fixturePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/fixture-echo.js");
  const catalogPath = path.join(root, "catalog.json");
  await writeFile(
    catalogPath,
    JSON.stringify({
      version: 1,
      entries: [
        {
          kind: "mcp",
          name: "echo-test",
          description: "Test server",
          trusted: true,
          transport: { type: "stdio", command: process.execPath, args: [fixturePath] },
        },
      ],
    }),
    "utf8",
  );
  const repository = new CatalogRepository(catalogPath, path.join(root, "state"));
  await repository.load();
  return new CapabilityHub(repository, pageChars === undefined ? {} : { pageChars });
}

const signal = () => new AbortController().signal;

// Numbered lines, so a lost, doubled or reordered character anywhere shows up.
const LONG = Array.from({ length: 900 }, (_, index) => `line ${String(index).padStart(4, "0")} of a long page`).join("\n");

function body(page: string): string {
  return page.replace(/\n\[capability_hub: page \d+ of \d+[^\]]*\]$/, "");
}

test("a long call result is served in pages below the DSH pruner threshold and reassembles exactly", async () => {
  const hub = await echoHub();
  try {
    const first = await hub.execute({ action: "call", name: "echo-test", tool: "echo", arguments: { text: LONG } }, signal());
    const firstText = text(first);
    assert.ok(firstText.length < DSH_PRUNER_THRESHOLD_CHARS, `page 1 is ${String(firstText.length)} chars`);
    assert.deepEqual(first.structuredContent, {
      paged: true,
      cursor: "r1:2",
      pages: splitPages(LONG, DEFAULT_PAGE_CHARS).length,
      totalChars: LONG.length,
      text: firstText,
    });
    assert.match(firstText, /Next page: \{"action":"page","cursor":"r1:2"\}\]$/);

    const parts = [body(firstText)];
    let cursor: string | null = "r1:2";
    while (cursor !== null) {
      const next = await hub.execute({ action: "page", cursor }, signal());
      const pageText = text(next);
      assert.ok(pageText.length < DSH_PRUNER_THRESHOLD_CHARS, `a page is ${String(pageText.length)} chars`);
      parts.push(body(pageText));
      const meta = next.structuredContent as { cursor: string | null; text: string };
      assert.equal(meta.text, pageText, "structuredContent carries the same page, for clients that ignore content.text");
      cursor = meta.cursor;
    }
    assert.match(parts.length > 1 ? text(await hub.execute({ action: "page", cursor: `r1:${String(parts.length)}` }, signal())) : "", /the last one\.\]$/);
    // Pages break on line ends where they can; dropping the one separator added before
    // each footer gives back the original text exactly.
    assert.equal(parts.join(""), LONG);
  } finally {
    await hub.close();
  }
});

test("paging the same text twice gives byte-identical pages, so a replayed chat stays cacheable", () => {
  assert.deepEqual(splitPages(LONG, DEFAULT_PAGE_CHARS), splitPages(LONG, DEFAULT_PAGE_CHARS));
  assert.equal(splitPages(LONG, DEFAULT_PAGE_CHARS).join(""), LONG);
  assert.deepEqual(splitPages("", DEFAULT_PAGE_CHARS), []);
});

test("a short result passes through untouched, and pageChars 0 turns paging off", async () => {
  const hub = await echoHub();
  const off = await echoHub(0);
  try {
    const short = await hub.execute({ action: "call", name: "echo-test", tool: "echo", arguments: { text: "hello" } }, signal());
    assert.equal(text(short), "hello");
    assert.equal(short.structuredContent, undefined);

    const whole = await off.execute({ action: "call", name: "echo-test", tool: "echo", arguments: { text: LONG } }, signal());
    assert.equal(text(whole), LONG);
  } finally {
    await hub.close();
    await off.close();
  }
});

test("a bad, unknown or out-of-range cursor fails with a reason the model can act on", async () => {
  const hub = await echoHub();
  try {
    await hub.execute({ action: "call", name: "echo-test", tool: "echo", arguments: { text: LONG } }, signal());
    await assert.rejects(hub.execute({ action: "page" }, signal()), /requires cursor/);
    await assert.rejects(hub.execute({ action: "page", cursor: "next" }, signal()), /r<number>:<page>/);
    await assert.rejects(hub.execute({ action: "page", cursor: "r9:2" }, signal()), /no longer held/);
    await assert.rejects(hub.execute({ action: "page", cursor: "r1:999" }, signal()), /has pages 1 to \d+/);
  } finally {
    await hub.close();
  }
});

test("a mistyped tool name comes back with the near misses instead of a dead end", async () => {
  const hub = await echoHub();
  try {
    await assert.rejects(
      hub.execute({ action: "call", name: "echo-test", tool: "echo_text", arguments: { text: "x" } }, signal()),
      /no tool "echo_text"; did you mean "echo"/,
    );
  } finally {
    await hub.close();
  }
  // A wrong name that shares a word still points at the right family.
  assert.deepEqual(suggestNames("web_fetch", ["web_info", "web_action", "page_text"]), ["web_action", "web_info"]);
  assert.deepEqual(suggestNames("zzz", ["web_info", "web_action"]), []);
  // Containment ranks above a shared word.
  assert.deepEqual(suggestNames("web_info_page", ["web_action", "web_info"]), ["web_info", "web_action"]);
  assert.deepEqual(suggestNames("click", ["browser_click", "browser_type", "click"]), ["browser_click", "click"]);
});
