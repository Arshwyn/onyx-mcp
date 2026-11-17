import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function localImports(file) {
  const src = readFileSync(join(root, file), "utf8");
  const re = /(?:from|import)\s*\(?\s*["'](\.\/[^"']+)["']/g;
  return [...src.matchAll(re)].map((m) => normalize(m[1]));
}

function reachableFrom(entry) {
  const seen = new Set();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    queue.push(...localImports(file));
  }
  return seen;
}

function copiedFiles() {
  const copied = new Set();
  for (const line of readFileSync(join(root, "Dockerfile"), "utf8").split("\n")) {
    const m = line.match(/^\s*COPY\s+(.*)$/i);
    if (!m || m[1].includes("--from")) continue;
    const parts = m[1].split(/\s+/).filter((p) => !p.startsWith("--"));
    for (const p of parts.slice(0, -1)) copied.add(normalize(p));
  }
  return copied;
}

test("Dockerfile copies every local module reachable from index.js", () => {
  const copied = copiedFiles();
  const missing = [...reachableFrom("index.js")].filter((f) => !copied.has(normalize(f)));
  assert.deepEqual(missing, []);
});
