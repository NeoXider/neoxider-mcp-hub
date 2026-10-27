import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("package allowlist excludes runtime state and compiled tests", async () => {
  const compiledRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const packageRoot = path.resolve(compiledRoot, "..");
  const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8")) as {
    files?: string[];
    version?: string;
  };
  const readme = await readFile(path.join(packageRoot, "README.md"), "utf8");

  assert.deepEqual(manifest.files, [
    "dist/src",
    "data/catalog.json",
    "data/skills",
    "examples",
    "cordis.patch.yml",
    "README.md",
    "CHANGELOG.md",
    "SECURITY.md",
    "LICENSE",
  ]);
  assert.match(readme, new RegExp(`badge/version-${manifest.version?.replaceAll(".", "\\.")}-`));
  assert.match(
    await readFile(path.join(packageRoot, "CHANGELOG.md"), "utf8"),
    new RegExp(`^## \\[${manifest.version?.replaceAll(".", "\\.")}\\]`, "m"),
    "the changelog has a section for the current version, which the release workflow publishes",
  );
});
