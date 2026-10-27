import assert from "node:assert/strict";
import test from "node:test";
import { matchTools, splitPages } from "../src/manager.js";

const TOOLS = [
  { name: "browser_click", description: "Click an element on the page" },
  { name: "browser_navigate", description: "Open a URL in the browser" },
  { name: "memory_create", description: "Create entities in the knowledge graph" },
  { name: "web_info" },
];

const names = (tools: readonly { name: string }[]): string[] => tools.map((tool) => tool.name);

test("an empty or blank query matches every tool", () => {
  assert.deepEqual(names(matchTools(TOOLS, undefined).matched), names(TOOLS));
  assert.deepEqual(names(matchTools(TOOLS, "   ").matched), names(TOOLS));
});

test("a single word is a substring match on the name or the description", () => {
  assert.deepEqual(names(matchTools(TOOLS, "click").matched), ["browser_click"]);
  assert.deepEqual(names(matchTools(TOOLS, "KNOWLEDGE").matched), ["memory_create"]);
  assert.deepEqual(matchTools(TOOLS, "nothing-here"), { matched: [], partial: false });
});

test("several words must all appear, in any order, so a phrase finds the underscored name", () => {
  assert.deepEqual(matchTools(TOOLS, "browser click"), { matched: [TOOLS[0]], partial: false });
  assert.deepEqual(matchTools(TOOLS, "click browser"), { matched: [TOOLS[0]], partial: false });
});

test("when no tool holds every word, the partial matches come back best first and are flagged", () => {
  const result = matchTools(TOOLS, "browser open url graph");
  assert.equal(result.partial, true);
  assert.deepEqual(names(result.matched), ["browser_navigate", "browser_click", "memory_create"]);
});

test("words that match nothing at all stay an empty, unflagged result", () => {
  assert.deepEqual(matchTools(TOOLS, "zzz yyy"), { matched: [], partial: false });
});

test("a page never ends between the halves of a surrogate pair", () => {
  const emoji = "\u{1F600}";
  const text = emoji.repeat(2_000);
  const pages = splitPages(text, 1_001);
  assert.equal(pages.join(""), text);
  for (const page of pages) {
    const last = page.charCodeAt(page.length - 1);
    assert.ok(!(last >= 0xd800 && last <= 0xdbff), "a page ends on a lone high surrogate");
    const first = page.charCodeAt(0);
    assert.ok(!(first >= 0xdc00 && first <= 0xdfff), "a page starts on a lone low surrogate");
  }
});

test("splitPages terminates even when a page is a single surrogate pair wide", () => {
  const text = "\u{1F600}".repeat(5);
  assert.equal(splitPages(text, 1).join(""), text);
});
