// Response header policy: baseline security headers, no-store for OAuth
// routes and an explicit CORS origin allowlist. Kept separate from index.js
// so it can be unit tested without starting the server.

const BASELINE_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
};

function applyBaseline(res) {
  for (const [name, value] of Object.entries(BASELINE_HEADERS)) {
    res.setHeader(name, value);
  }
}

// Sets the baseline headers on every response. They are applied again just
// before the head is written because Express's default error and 404 pages
// set their own Content-Security-Policy. Headers a transport passes to
// writeHead (such as Cache-Control on SSE) are left alone.
export function baselineHeaders(req, res, next) {
  applyBaseline(res);
  const writeHead = res.writeHead;
  res.writeHead = function (...args) {
    applyBaseline(this);
    return writeHead.apply(this, args);
  };
  next();
}

// Mounted on /oauth so authorization codes and tokens are never cached.
export function noStore(req, res, next) {
  res.setHeader("Cache-Control", "no-store");
  next();
}

export const CORS_ALLOW_METHODS = "GET, POST, DELETE, OPTIONS";
export const CORS_ALLOW_HEADERS =
  "Authorization, Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID";
export const CORS_EXPOSE_HEADERS = "Mcp-Session-Id, WWW-Authenticate";
export const CORS_MAX_AGE = "600";

function isExactOrigin(entry) {
  let url;
  try {
    url = new URL(entry);
  } catch {
    return false;
  }
  // url.origin drops paths, queries, trailing slashes and userinfo, and
  // normalizes case and default ports; requiring an exact match rejects all
  // of those. "null" and "*" fail to parse above.
  if (url.origin !== entry || entry.includes("*")) return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && url.hostname === "localhost";
}

// Parses a comma-separated list of exact origins. Returns a de-duplicated
// array (empty when unset or blank). Throws an Error naming only the
// variable, never the offending value.
export function parseAllowedOrigins(raw) {
  if (raw === undefined || raw === null) return [];
  const entries = String(raw)
    .split(",")
    .map((e) => e.trim())
    .filter((e) => e !== "");
  for (const entry of entries) {
    if (!isExactOrigin(entry)) {
      throw new Error("CORS_ALLOWED_ORIGINS contains an invalid origin");
    }
  }
  return [...new Set(entries)];
}

// CORS middleware for an allowlist of exact origins. With an empty list it
// does nothing. Never uses "*", never sends credentials headers, never
// reflects an origin that is not in the list. Requests from other origins
// are handled normally, just without any Access-Control-* headers.
export function corsAllowlist(origins) {
  const allowed = new Set(origins);
  if (allowed.size === 0) return (req, res, next) => next();
  return (req, res, next) => {
    res.vary("Origin");
    const origin = req.headers.origin;
    if (typeof origin !== "string" || !allowed.has(origin)) return next();
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Expose-Headers", CORS_EXPOSE_HEADERS);
    const isPreflight =
      req.method === "OPTIONS" && req.headers["access-control-request-method"] !== undefined;
    if (!isPreflight) return next();
    res.setHeader("Access-Control-Allow-Methods", CORS_ALLOW_METHODS);
    res.setHeader("Access-Control-Allow-Headers", CORS_ALLOW_HEADERS);
    res.setHeader("Access-Control-Max-Age", CORS_MAX_AGE);
    res.setHeader("Content-Length", "0");
    res.statusCode = 204;
    res.end();
  };
}
