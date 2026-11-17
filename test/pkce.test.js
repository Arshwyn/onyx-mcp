import test from "node:test";
import assert from "node:assert/strict";
import { challengeFromVerifier, validateChallengeRequest, verifyCodeVerifier, redeemAuthCode } from "../pkce.js";

// RFC 7636 appendix B test vector.
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

test("challengeFromVerifier matches the RFC 7636 vector", () => {
  assert.equal(challengeFromVerifier(VERIFIER), CHALLENGE);
});

test("authorize request with S256 challenge is accepted", () => {
  assert.deepEqual(validateChallengeRequest(CHALLENGE, "S256"), { ok: true });
});

test("authorize request without a challenge is rejected", () => {
  for (const c of [undefined, "", null, ["a"]]) {
    assert.equal(validateChallengeRequest(c, "S256").ok, false);
  }
});

test("authorize request with plain, missing or unknown method is rejected", () => {
  for (const m of ["plain", undefined, "", "s256", "S512"]) {
    assert.equal(validateChallengeRequest(CHALLENGE, m).ok, false);
  }
});

test("authorize request with a malformed challenge is rejected", () => {
  for (const c of ["short", CHALLENGE + "A", CHALLENGE.slice(0, 42) + "+"]) {
    assert.equal(validateChallengeRequest(c, "S256").ok, false);
  }
});

test("correct verifier is accepted", () => {
  assert.equal(verifyCodeVerifier(CHALLENGE, VERIFIER), true);
});

test("wrong verifier is rejected", () => {
  assert.equal(verifyCodeVerifier(CHALLENGE, "x".repeat(43)), false);
});

test("missing, malformed or odd-length inputs are rejected without throwing", () => {
  for (const v of [undefined, null, "", "short", "a".repeat(129), "bad verifier with spaces and more padding!!!", 5]) {
    assert.equal(verifyCodeVerifier(CHALLENGE, v), false);
  }
  for (const c of [undefined, null, "", "short"]) {
    assert.equal(verifyCodeVerifier(c, VERIFIER), false);
  }
});

test("redeemAuthCode accepts a correct verifier once and rejects reuse", () => {
  const codes = new Map([["c1", { clientId: "id", redirectUri: "https://x/cb", codeChallenge: CHALLENGE, expiresAt: Date.now() + 1000 }]]);
  const args = { code: "c1", clientId: "id", redirectUri: "https://x/cb", codeVerifier: VERIFIER };
  assert.equal(redeemAuthCode(codes, args).ok, true);
  assert.equal(redeemAuthCode(codes, args).ok, false);
});

test("redeemAuthCode consumes the code on a wrong verifier", () => {
  const codes = new Map([["c1", { clientId: "id", redirectUri: "https://x/cb", codeChallenge: CHALLENGE, expiresAt: Date.now() + 1000 }]]);
  const bad = { code: "c1", clientId: "id", redirectUri: "https://x/cb", codeVerifier: "x".repeat(43) };
  assert.equal(redeemAuthCode(codes, bad).ok, false);
  assert.equal(redeemAuthCode(codes, { ...bad, codeVerifier: VERIFIER }).ok, false);
});

test("redeemAuthCode rejects expired codes and client or redirect mismatch", () => {
  const mk = () => new Map([["c1", { clientId: "id", redirectUri: "https://x/cb", codeChallenge: CHALLENGE, expiresAt: 100 }]]);
  const ok = { code: "c1", clientId: "id", redirectUri: "https://x/cb", codeVerifier: VERIFIER };
  assert.equal(redeemAuthCode(mk(), { ...ok, now: 101 }).ok, false);
  assert.equal(redeemAuthCode(mk(), { ...ok, now: 50, clientId: "other" }).ok, false);
  assert.equal(redeemAuthCode(mk(), { ...ok, now: 50, redirectUri: "https://x/other" }).ok, false);
  assert.equal(redeemAuthCode(mk(), { ...ok, now: 50 }).ok, true);
});
