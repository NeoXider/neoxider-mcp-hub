#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { argumentValue } from "./wire.js";

// Fields that can be typed as plain flags, with no JSON in the command line. Windows
// PowerShell 5.1 strips the double quotes from `--json '{"action":"search"}'` before
// node sees them, so the simple requests need a form that survives every shell.
const FLAG_FIELDS = ["action", "query", "kind", "name", "tool", "cursor"] as const;

function requestFromFlags(): Record<string, unknown> | undefined {
  const fields = FLAG_FIELDS.flatMap((field) => {
    const value = argumentValue(`--${field}`);
    return value === undefined ? [] : [[field, value] as const];
  });
  return fields.length === 0 ? undefined : Object.fromEntries(fields);
}

function parseRequest(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `The request is not valid JSON (${detail}). Windows PowerShell 5.1 removes double quotes from a ` +
        "quoted argument; put the request in a file and pass --input request.json, or use plain flags " +
        "such as --action search --query demo.",
    );
  }
}

// The three payload fields collapsed into `payloadJson` in 0.5.0. This CLI still accepts
// the readable object forms, because a human typing a request should not have to escape
// JSON inside JSON, and it still accepts the retired *Json spellings. They are folded
// into `payloadJson` here before sending; the server additionally advertises a
// structured `arguments` object for action call, which the MCP SDK passes through
// untouched precisely because it is a declared field rather than an unknown key.
function normalizeConvenienceFields(input: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...input };
  for (const source of ["arguments", "config", "entry"] as const) {
    if (normalized[source] !== undefined && normalized.payloadJson === undefined) {
      normalized.payloadJson = JSON.stringify(normalized[source]);
    }
    delete normalized[source];
  }
  for (const retired of ["argumentsJson", "configJson", "entryJson"] as const) {
    if (normalized[retired] !== undefined && normalized.payloadJson === undefined) {
      normalized.payloadJson = normalized[retired];
    }
    delete normalized[retired];
  }
  return normalized;
}

async function main(): Promise<void> {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const packageDir = path.resolve(moduleDir, "../..");
  const catalog = path.resolve(argumentValue("--catalog") ?? path.join(packageDir, "data", "catalog.json"));
  const state = path.resolve(argumentValue("--state") ?? path.join(packageDir, "data", "state"));
  const inputFile = argumentValue("--input");
  const inline = argumentValue("--json");
  const flagged = inputFile || inline ? undefined : requestFromFlags();
  if (!inputFile && !inline && !flagged) {
    throw new Error(
      "Usage: capability-hub-client (--action NAME [--query Q] [--name N] [--kind mcp|skill] [--tool T] " +
        '| --json "{...}" | --input request.json) [--catalog file] [--state dir]',
    );
  }

  const raw = inputFile ? await readFile(path.resolve(inputFile), "utf8") : inline;
  const input = normalizeConvenienceFields(flagged ?? parseRequest(raw as string));
  const client = new Client({ name: "capability-hub-smoke-client", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(packageDir, "dist", "src", "server.js"), "--catalog", catalog, "--state", state],
    stderr: "inherit",
  });

  try {
    await client.connect(transport);
    const result = await client.callTool({ name: "capability_hub", arguments: input });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.isError) process.exitCode = 2;
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
