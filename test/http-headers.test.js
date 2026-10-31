import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import {
  baselineHeaders,
  noStore,
  parseAllowedOrigins,
  corsAllowlist,
  CORS_ALLOW_METHODS,
  CORS_ALLOW_HEADERS,
  CORS_EXPOSE_HEADERS,
  CORS_MAX_AGE,
} from "../http-headers.js";

const ALLOWED = "https://app.example.com";
const OTHER = "https://other.example.com";

async function withServer(allowlistRaw, fn) {
  const app = express();
  app.disable("x-powered-by");
  app.use(baselineHeaders);
  app.use(corsAllowlist(parseAllowedOrigins(allowlistRaw)));
  app.use("/oauth", noStore);
  app.get("/", (req, res) => res.send("ok"));
  app.post("/oauth/token", (req, res) => res.status(400).json({ error: "invalid_request" }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function acHeaders(res) {
  return [...res.headers.keys()].filter((k) => k.startsWith("access-control-"));
}

test("no X-Powered-By and baseline headers on every response", async () => {
  await withServer("", async (base) => {
    for (const path of ["/", "/missing"]) {
      const res = await fetch(base + path);
      assert.equal(res.headers.get("x-powered-by"), null);
      assert.equal(res.headers.get("x-content-type-options"), "nosniff");
      assert.equal(res.headers.get("referrer-policy"), "no-referrer");
      assert.equal(res.headers.get("x-frame-options"), "DENY");
      assert.equal(
        res.headers.get("content-security-policy"),
        "default-src 'none'; frame-ancestors 'none'"
      );
    }
  });
});

test("Cache-Control no-store only on /oauth responses, including errors", async () => {
  await withServer("", async (base) => {
    const token = await fetch(base + "/oauth/token", { method: "POST" });
    assert.equal(token.status, 400);
    assert.equal(token.headers.get("cache-control"), "no-store");
    const unknown = await fetch(base + "/oauth/nope");
    assert.equal(unknown.headers.get("cache-control"), "no-store");
    const root = await fetch(base + "/");
    assert.equal(root.headers.get("cache-control"), null);
  });
});

test("parseAllowedOrigins accepts valid origins, trims and de-duplicates", () => {
  assert.deepEqual(parseAllowedOrigins(undefined), []);
  assert.deepEqual(parseAllowedOrigins(""), []);
  assert.deepEqual(parseAllowedOrigins("  , "), []);
  assert.deepEqual(
    parseAllowedOrigins(` ${ALLOWED} , http://localhost:3000,${ALLOWED},https://host.example.com:8443`),
    [ALLOWED, "http://localhost:3000", "https://host.example.com:8443"]
  );
});

test("parseAllowedOrigins rejects invalid entries without echoing the value", () => {
  const bad = [
    "https://app.example.com/path",
    "https://app.example.com/",
    "https://app.example.com?x=1",
    "https://app.example.com#frag",
    "*",
    "https://*.example.com",
    "null",
    "http://app.example.com",
    "http://127.0.0.1:3000",
    "not a url",
    "app.example.com",
    "https://user@app.example.com",
    "https://APP.example.com",
    `${ALLOWED},https://bad.example.com/x`,
  ];
  for (const raw of bad) {
    assert.throws(
      () => parseAllowedOrigins(raw),
      (err) => err.message === "CORS_ALLOWED_ORIGINS contains an invalid origin",
      raw
    );
  }
});

test("empty allowlist sends no Access-Control headers, even on preflight", async () => {
  await withServer("", async (base) => {
    const res = await fetch(base + "/", { headers: { Origin: ALLOWED } });
    assert.equal(res.status, 200);
    assert.deepEqual(acHeaders(res), []);
    const pre = await fetch(base + "/", {
      method: "OPTIONS",
      headers: {
        Origin: ALLOWED,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization",
      },
    });
    assert.deepEqual(acHeaders(pre), []);
    assert.equal(pre.status !== 204, true);
  });
});

test("allowed origin gets exact ACAO and Vary on normal responses", async () => {
  await withServer(ALLOWED, async (base) => {
    const res = await fetch(base + "/", { headers: { Origin: ALLOWED } });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "ok");
    assert.equal(res.headers.get("access-control-allow-origin"), ALLOWED);
    assert.match(res.headers.get("vary"), /Origin/);
    assert.equal(res.headers.get("access-control-expose-headers"), CORS_EXPOSE_HEADERS);
    assert.equal(res.headers.get("access-control-allow-credentials"), null);
  });
});

test("allowed origin preflight returns 204 with the configured lists", async () => {
  await withServer(ALLOWED, async (base) => {
    const res = await fetch(base + "/", {
      method: "OPTIONS",
      headers: {
        Origin: ALLOWED,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization,content-type,mcp-session-id",
      },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("access-control-allow-origin"), ALLOWED);
    assert.equal(res.headers.get("access-control-allow-methods"), CORS_ALLOW_METHODS);
    assert.equal(res.headers.get("access-control-allow-headers"), CORS_ALLOW_HEADERS);
    assert.match(res.headers.get("access-control-allow-headers"), /Authorization/);
    assert.match(res.headers.get("access-control-allow-headers"), /Mcp-Session-Id/);
    assert.match(res.headers.get("access-control-expose-headers"), /Mcp-Session-Id/);
    assert.equal(res.headers.get("access-control-max-age"), CORS_MAX_AGE);
    assert.match(res.headers.get("vary"), /Origin/);
    assert.equal(res.headers.get("access-control-allow-credentials"), null);
    assert.notEqual(res.headers.get("access-control-allow-origin"), "*");
  });
});

test("disallowed origin gets no Access-Control headers and is handled normally", async () => {
  await withServer(ALLOWED, async (base) => {
    const res = await fetch(base + "/", { headers: { Origin: OTHER } });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "ok");
    assert.deepEqual(acHeaders(res), []);
    assert.match(res.headers.get("vary"), /Origin/);
    const pre = await fetch(base + "/", {
      method: "OPTIONS",
      headers: { Origin: OTHER, "Access-Control-Request-Method": "POST" },
    });
    assert.deepEqual(acHeaders(pre), []);
    assert.notEqual(pre.status, 204);
  });
});

test("requests without Origin behave as before", async () => {
  await withServer(ALLOWED, async (base) => {
    const res = await fetch(base + "/");
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "ok");
    assert.deepEqual(acHeaders(res), []);
  });
});
