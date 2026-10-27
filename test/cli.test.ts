import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");
const packageDir = path.resolve(srcDir, "../..");

async function node(script: string, args: string[], cwd?: string): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const result = await run(process.execPath, [path.join(srcDir, script), ...args], { cwd: cwd ?? packageDir, timeout: 60_000 });
    return { stdout: result.stdout, stderr: result.stderr, code: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", code: failure.code ?? 1 };
  }
}

test("the client takes a plain-flag request, so no quote survives a shell as JSON", async () => {
  const result = await node("client.js", ["--action", "search", "--query", "demo"]);
  assert.equal(result.code, 0, result.stderr);
  const reply = JSON.parse(result.stdout) as { structuredContent: { capabilities: { name: string }[] } };
  assert.ok(reply.structuredContent.capabilities.some((entry) => entry.name === "demo-echo"));
});

test("a request whose quotes a shell stripped says how to send it instead", async () => {
  const result = await node("client.js", ["--json", "{action:search,query:demo}"]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /not valid JSON/);
  assert.match(result.stderr, /--input request\.json/);
  assert.match(result.stderr, /--action search/);
});

test("the client without a request prints its usage, flags included", async () => {
  const result = await node("client.js", []);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /--action NAME/);
});

test("the admin command defaults to the package's catalog and state, not the working directory", async () => {
  const elsewhere = await mkdtemp(path.join(os.tmpdir(), "capability-hub-admin-cwd-"));
  const result = await node("admin.js", ["approve", "00000000-0000-4000-8000-000000000000", "--yes"], elsewhere);
  assert.notEqual(result.code, 0);
  const expected = path.join(packageDir, "data", "state", "pending");
  assert.ok(result.stderr.includes(expected), `expected the package state in: ${result.stderr}`);
  assert.ok(!result.stderr.includes(elsewhere), "the working directory must not be consulted");
});

test("a flag followed by another flag has no value", async () => {
  const result = await node("client.js", ["--catalog", "--action", "search", "--query", "demo"]);
  assert.equal(result.code, 0, result.stderr);
  const reply = JSON.parse(result.stdout) as { structuredContent: { total: number } };
  assert.ok(reply.structuredContent.total >= 1, "the default catalog is used");
});
