import type { CatalogRepository } from "./catalog.js";

export const BASE_DESCRIPTION =
  "Search and inspect a compact catalog, enable a trusted MCP only when needed, list its tools, proxy a tool call, or load one skill body. " +
  'Action "tools" starts a stopped capability by itself, so "enable" is only for starting one deliberately. ' +
  "Avoid includeSchema unless you need the argument shape. Third-party proposals require human approval outside this MCP.";

// Roughly four characters per token; a hard character budget keeps the resident cost
// bounded without dragging a tokenizer into the server's dependencies.
export const INLINE_CATALOG_CHAR_BUDGET = 3_000;

// The capability list ships INSIDE the resident description, rather than being something
// the model has to spend a `search` round trip to discover.
//
// This is not a guess. bench/accuracy.mjs measured the same 28 tasks on the same model
// with and without it: 92.9% -> 100% accuracy, and average turns 3.96 -> 2.43, for 223
// extra resident tokens on a four-entry catalog. The failures it removed were the ones
// where the task does not read like a search query, so the model never searched at all
// and simply answered without the capability.
//
// A large catalog would undo the saving this whole project exists for, so the list
// degrades: full descriptions, then names only, then a pointer to `search`.
export function describeHub(repository: CatalogRepository): string {
  const entries = repository.all();
  if (entries.length === 0) return BASE_DESCRIPTION;

  const detailed = entries.map((entry) => `${entry.name} (${entry.kind}): ${entry.description}`).join(" | ");
  if (detailed.length <= INLINE_CATALOG_CHAR_BUDGET) {
    return `${BASE_DESCRIPTION}\nAvailable capabilities — ${detailed}`;
  }

  const names = entries.map((entry) => entry.name).join(", ");
  if (names.length <= INLINE_CATALOG_CHAR_BUDGET) {
    return `${BASE_DESCRIPTION}\nAvailable capabilities: ${names}. Use action "search" for descriptions.`;
  }

  return `${BASE_DESCRIPTION}\n${entries.length} capabilities are available; use action "search" to list them.`;
}
