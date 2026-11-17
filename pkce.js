import crypto from "node:crypto";

// PKCE (RFC 7636) helpers. Only the S256 method is supported.

const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;

export function challengeFromVerifier(verifier) {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

// Returns { ok: true } or { ok: false, reason } for the authorize request.
export function validateChallengeRequest(codeChallenge, codeChallengeMethod) {
  if (typeof codeChallenge !== "string" || !codeChallenge) return { ok: false, reason: "missing code_challenge" };
  if (codeChallengeMethod !== "S256") return { ok: false, reason: "code_challenge_method must be S256" };
  if (!CHALLENGE_RE.test(codeChallenge)) return { ok: false, reason: "malformed code_challenge" };
  return { ok: true };
}

// Constant-time check of a verifier against the stored S256 challenge.
export function verifyCodeVerifier(storedChallenge, verifier) {
  if (typeof storedChallenge !== "string" || typeof verifier !== "string") return false;
  if (!VERIFIER_RE.test(verifier)) return false;
  const computed = Buffer.from(challengeFromVerifier(verifier));
  const stored = Buffer.from(storedChallenge);
  if (computed.length !== stored.length) return false;
  return crypto.timingSafeEqual(computed, stored);
}
