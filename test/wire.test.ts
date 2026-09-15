import assert from "node:assert/strict";
import test from "node:test";
import { decodeWireInput } from "../src/wire.js";

test("decodeWireInput accepts structured arguments for call", () => {
  assert.deepEqual(
    decodeWireInput({ action: "call", name: "x", tool: "y", arguments: { url: "https://example.com", n: 2 } }),
    { action: "call", name: "x", tool: "y", arguments: { url: "https://example.com", n: 2 } },
  );
});

test("decodeWireInput keeps the payloadJson path for call", () => {
  assert.deepEqual(
    decodeWireInput({ action: "call", name: "x", tool: "y", payloadJson: '{"a":1}' }),
    { action: "call", name: "x", tool: "y", arguments: { a: 1 } },
  );
});

test("decodeWireInput rejects arguments combined with payloadJson", () => {
  assert.throws(
    () => decodeWireInput({ action: "call", name: "x", tool: "y", arguments: { a: 1 }, payloadJson: '{"a":1}' }),
    /either as "arguments" or as "payloadJson", not both/,
  );
});

test("decodeWireInput rejects structured arguments on other actions", () => {
  assert.throws(
    () => decodeWireInput({ action: "search", arguments: { a: 1 } }),
    /takes no arguments; it is for action "call"/,
  );
});

test("decodeWireInput rejects non-object structured arguments", () => {
  assert.throws(
    () => decodeWireInput({ action: "call", name: "x", tool: "y", arguments: [1] as unknown as Record<string, unknown> }),
    /arguments must contain a JSON object/,
  );
});

test("decodeWireInput rejects non-JSON values in structured arguments", () => {
  for (const bad of [undefined, () => undefined, Symbol("s"), Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => decodeWireInput({ action: "call", name: "x", tool: "y", arguments: { a: bad as unknown } }),
      /must contain JSON-serializable values/,
    );
  }
});

test("decodeWireInput leaves other payload actions untouched", () => {
  assert.deepEqual(decodeWireInput({ action: "configure", name: "x", payloadJson: '{"k":"v"}' }), {
    action: "configure",
    name: "x",
    config: { k: "v" },
  });
});
