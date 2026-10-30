import test from "node:test";
import assert from "node:assert/strict";
import {
  validateSetOverride,
  buildOverrideRow,
  setOverrideMessage,
  formatOverrideResponse,
  isValidDate,
} from "../daily-override.js";

const DATE = "2026-01-01";

test("routine override with isRest false", () => {
  const r = validateSetOverride({ date: DATE, routineId: 1, isRest: false });
  assert.deepEqual(r, { ok: true, date: DATE, routineId: 1, isRest: false });
  assert.deepEqual(buildOverrideRow("user-1", r), { user_id: "user-1", date: DATE, routine_id: 1, is_rest: false });
});

test("legacy call without isRest is a routine override", () => {
  const r = validateSetOverride({ date: DATE, routineId: 1 });
  assert.deepEqual(buildOverrideRow("user-1", r), { user_id: "user-1", date: DATE, routine_id: 1, is_rest: false });
});

test("rest day with null routineId", () => {
  const r = validateSetOverride({ date: DATE, routineId: null, isRest: true });
  assert.deepEqual(buildOverrideRow("user-1", r), { user_id: "user-1", date: DATE, routine_id: null, is_rest: true });
});

test("rest day with omitted routineId", () => {
  const r = validateSetOverride({ date: DATE, isRest: true });
  assert.deepEqual(buildOverrideRow("user-1", r), { user_id: "user-1", date: DATE, routine_id: null, is_rest: true });
});

test("rejects rest day with a routineId", () => {
  const r = validateSetOverride({ date: DATE, routineId: 1, isRest: true });
  assert.equal(r.ok, false);
  assert.match(r.error, /rest day cannot have a routineId/);
});

test("rejects routine override without a routine", () => {
  for (const args of [{ date: DATE }, { date: DATE, routineId: null }, { date: DATE, routineId: null, isRest: false }]) {
    const r = validateSetOverride(args);
    assert.equal(r.ok, false);
    assert.match(r.error, /routineId is required/);
  }
});

test("rejects invalid routineId", () => {
  for (const routineId of [0, -1, 1.5, "1", NaN, true, {}]) {
    const r = validateSetOverride({ date: DATE, routineId });
    assert.equal(r.ok, false, String(routineId));
    assert.match(r.error, /positive integer/);
  }
});

test("rejects invalid dates", () => {
  for (const date of [undefined, "", "2026-1-1", "01-01-2026", "2026-13-01", "2026-02-30", "2026-01-01T00:00", 20260101]) {
    const r = validateSetOverride({ date, routineId: 1 });
    assert.equal(r.ok, false, String(date));
    assert.match(r.error, /YYYY-MM-DD/);
  }
  assert.equal(isValidDate("2026-02-28"), true);
});

test("rejects non-boolean isRest", () => {
  const r = validateSetOverride({ date: DATE, isRest: "true" });
  assert.equal(r.ok, false);
  assert.match(r.error, /isRest must be a boolean/);
});

test("user_id comes only from the caller, not arguments", () => {
  const r = validateSetOverride({ date: DATE, routineId: 1, user_id: "other", userId: "other" });
  assert.equal(buildOverrideRow("user-1", r).user_id, "user-1");
});

test("success messages differ", () => {
  assert.match(setOverrideMessage({ date: DATE, routineId: null, isRest: true }), /rest day/);
  assert.match(setOverrideMessage({ date: DATE, routineId: 1, isRest: false }), /routine id 1/);
});

test("get response shape for rest and routine rows", () => {
  assert.deepEqual(formatOverrideResponse({ date: DATE, routine_id: null, is_rest: true }), { date: DATE, routine_id: null, is_rest: true });
  assert.deepEqual(formatOverrideResponse({ date: DATE, routine_id: 1, is_rest: false }), { date: DATE, routine_id: 1, is_rest: false });
  assert.deepEqual(formatOverrideResponse(null), { message: "No override found for this date" });
});
