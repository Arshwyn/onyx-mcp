import crypto from "crypto";
import fs from "fs";
import path from "path";

export const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
export const REFRESH_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;
export const DEFAULT_STORE_PATH = "/data/tokens.json";

export function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

// Token store: issues access/refresh tokens and keeps only SHA-256 hashes.
// State is persisted to a small JSON file (atomic write, mode 0600) so tokens
// survive restarts. If the file cannot be read or written the store keeps
// working in memory and logs a warning (never a token value).
export function createTokenStore({
  filePath = null,
  now = Date.now,
  accessTtlMs = ACCESS_TOKEN_TTL_MS,
  refreshTtlMs = REFRESH_TOKEN_TTL_MS,
  warn = console.warn,
} = {}) {
  // hash -> { clientId, family, expiresAt }
  let access = new Map();
  // hash -> { clientId, family, expiresAt, rotated }
  let refresh = new Map();
  let persist = Boolean(filePath);

  function prune() {
    const t = now();
    for (const [h, e] of access) if (e.expiresAt <= t) access.delete(h);
    for (const [h, e] of refresh) if (e.expiresAt <= t) refresh.delete(h);
  }

  function save() {
    if (!persist) return;
    prune();
    const data = JSON.stringify({
      version: 1,
      access: Object.fromEntries(access),
      refresh: Object.fromEntries(refresh),
    });
    const tmp = `${filePath}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, data, { mode: 0o600 });
      fs.renameSync(tmp, filePath);
    } catch (err) {
      warn(`Token store write failed (${err.code || "error"}); continuing in memory only`);
      try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    }
  }

  function load() {
    if (!filePath) return;
    let raw;
    try {
      raw = fs.readFileSync(filePath, "utf8");
    } catch (err) {
      if (err.code === "ENOENT") {
        try {
          fs.mkdirSync(path.dirname(filePath), { recursive: true });
          fs.accessSync(path.dirname(filePath), fs.constants.W_OK);
        } catch {
          warn("Token store directory is not writable; tokens are kept in memory only");
          persist = false;
        }
      } else {
        warn(`Token store unreadable (${err.code || "error"}); tokens are kept in memory only`);
        persist = false;
      }
      return;
    }
    try {
      const parsed = JSON.parse(raw);
      access = new Map(Object.entries(parsed.access || {}));
      refresh = new Map(Object.entries(parsed.refresh || {}));
      prune();
    } catch {
      // Do not overwrite a file we could not understand.
      warn("Token store file is corrupt; starting empty and leaving the file untouched (in memory only)");
      persist = false;
    }
  }

  function mint(clientId, family) {
    const accessToken = crypto.randomBytes(32).toString("hex");
    const refreshToken = crypto.randomBytes(32).toString("hex");
    const t = now();
    access.set(hashToken(accessToken), { clientId, family, expiresAt: t + accessTtlMs });
    refresh.set(hashToken(refreshToken), { clientId, family, expiresAt: t + refreshTtlMs, rotated: false });
    return { accessToken, refreshToken, expiresIn: Math.floor(accessTtlMs / 1000) };
  }

  function revokeFamily(family) {
    for (const [h, e] of access) if (e.family === family) access.delete(h);
    for (const [h, e] of refresh) if (e.family === family) refresh.delete(h);
  }

  load();

  return {
    issue(clientId) {
      const out = mint(clientId, crypto.randomUUID());
      save();
      return out;
    },
    // Returns { clientId } for a valid access token, else null.
    lookupAccess(token) {
      if (typeof token !== "string" || !token) return null;
      const e = access.get(hashToken(token));
      if (!e || e.expiresAt <= now()) return null;
      return { clientId: e.clientId };
    },
    // Rotates a refresh token. Returns tokens or { error: "invalid_grant" }.
    refresh(token, clientId) {
      if (typeof token !== "string" || !token) return { error: "invalid_grant" };
      const h = hashToken(token);
      const e = refresh.get(h);
      if (!e || e.expiresAt <= now() || e.clientId !== clientId) return { error: "invalid_grant" };
      if (e.rotated) {
        // Reuse of a rotated token: revoke the whole family.
        revokeFamily(e.family);
        save();
        return { error: "invalid_grant" };
      }
      e.rotated = true;
      const out = mint(clientId, e.family);
      // Superseded access tokens of this family stay valid until they expire.
      save();
      return out;
    },
    revokeClient(clientId) {
      for (const [h, e] of access) if (e.clientId === clientId) access.delete(h);
      for (const [h, e] of refresh) if (e.clientId === clientId) refresh.delete(h);
      save();
    },
  };
}
