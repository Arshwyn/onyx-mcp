import crypto from "crypto";

// Constant-time secret comparison over SHA-256 digests (fixed length, so
// timingSafeEqual never throws). Missing or non-string values never match.
export function secretsMatch(expected, provided) {
  if (typeof expected !== "string" || typeof provided !== "string") return false;
  const a = crypto.createHash("sha256").update(expected).digest();
  const b = crypto.createHash("sha256").update(provided).digest();
  return crypto.timingSafeEqual(a, b);
}

// Render a client-supplied value for a log line: JSON-quoted so control
// characters and newlines are escaped and cannot forge extra log lines.
export function logValue(value) {
  const json = JSON.stringify(value);
  return json === undefined ? "undefined" : json;
}
