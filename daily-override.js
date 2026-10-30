// Validation and row-building for daily overrides. Kept free of server and
// Supabase imports so it can be unit-tested in isolation.
//
// A routine override is a row with a routine_id and is_rest false; a rest day
// is a row with routine_id null and is_rest true (see the table check
// constraint daily_overrides_rest_xor_routine).

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidDate(date) {
  if (typeof date !== "string" || !DATE_RE.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

// Returns { ok: true, date, routineId, isRest } or { ok: false, error }.
export function validateSetOverride(args) {
  const { date, routineId, isRest } = args || {};

  if (!isValidDate(date)) {
    return { ok: false, error: "date must be a valid date in YYYY-MM-DD format." };
  }
  if (isRest !== undefined && isRest !== null && typeof isRest !== "boolean") {
    return { ok: false, error: "isRest must be a boolean." };
  }
  const rest = isRest === true;
  const hasRoutine = routineId !== undefined && routineId !== null;

  if (hasRoutine && !(Number.isInteger(routineId) && routineId > 0)) {
    return { ok: false, error: "routineId must be a positive integer." };
  }
  if (rest && hasRoutine) {
    return { ok: false, error: "A rest day cannot have a routineId; omit routineId or pass null when isRest is true." };
  }
  if (!rest && !hasRoutine) {
    return { ok: false, error: "routineId is required for a routine override; to mark a rest day pass isRest: true." };
  }
  return { ok: true, date, routineId: rest ? null : routineId, isRest: rest };
}

export function buildOverrideRow(userId, { date, routineId, isRest }) {
  return { user_id: userId, date, routine_id: routineId, is_rest: isRest };
}

export function setOverrideMessage({ date, routineId, isRest }) {
  return isRest
    ? `Successfully set ${date} as a rest day.`
    : `Successfully set routine override (routine id ${routineId}) for ${date}.`;
}

// Columns returned by get_daily_override.
export const OVERRIDE_SELECT = "date, routine_id, is_rest";

export function formatOverrideResponse(row) {
  if (!row) return { message: "No override found for this date" };
  return { date: row.date, routine_id: row.routine_id ?? null, is_rest: row.is_rest === true };
}
