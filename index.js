import 'dotenv/config';
import express from "express";
import cors from "cors";
import crypto from "crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createClient } from '@supabase/supabase-js';
import { validateSetOverride, buildOverrideRow, setOverrideMessage, formatOverrideResponse, OVERRIDE_SELECT } from "./daily-override.js";
import { secretsMatch, logValue } from "./security.js";

const app = express();

// Requests typically arrive over plain HTTP from a reverse proxy or tunnel
// that terminates TLS -- honor X-Forwarded-Proto so req.protocol reflects
// what the original client actually used, not the proxy-side hop. Without
// this, every OAuth discovery URL and the WWW-Authenticate header advertise
// http:// even when served over https://.
app.set("trust proxy", true);

// Do not advertise the framework in responses.
app.disable("x-powered-by");

// Blanket request trace for diagnosing the OAuth flow -- method and path
// only. Never log headers or bodies here: Authorization headers and
// token-exchange client_secrets pass through routes this logger sees.
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

app.use(cors());

// SUPABASE_URL is preferred; VITE_SUPABASE_URL is accepted as a fallback.
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  const missing = [!SUPABASE_URL && "SUPABASE_URL", !SUPABASE_SERVICE_ROLE_KEY && "SUPABASE_SERVICE_ROLE_KEY"].filter(Boolean);
  console.error(`Missing required configuration: ${missing.join(", ")}`);
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Supabase occasionally 401s a single request out of an otherwise-healthy
// batch (seen on body_weights while a sibling circumferences call in the
// same Promise.all succeeded). Without this, that leg's error was swallowed
// and .data came back null, which get_body_metrics then handed to the
// caller as a silent "no weights" instead of a retryable failure.
function applyDateRange(query, args) {
  if (args.startDate) query = query.gte('date', args.startDate);
  if (args.endDate) query = query.lte('date', args.endDate);
  return query;
}

async function selectWithRetry(queryFactory, { retries = 1, delayMs = 300 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const { data, error } = await queryFactory();
    if (!error) return data;
    lastError = error;
    if (attempt < retries) await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  throw lastError;
}

// Clients come from the environment: OAUTH_CLIENTS is a comma-separated list
// of names (lowercase letters, digits, hyphens); for each name <N> (uppercased,
// "-" -> "_") the keys OAUTH_CLIENT_<N>_ID, _SECRET, _USER_ID and _REDIRECT_URI
// are read. client_id is not secret (it's typed into the connector's "OAuth
// Client ID" field); client_secret is the OAuth client secret.
// redirectUri is Claude's actual callback URL for that connector -- required
// so /oauth/authorize can't be used as an open redirector by anyone who
// knows a (non-secret) client_id. Only key names are ever logged, never values.
function loadClients(env) {
  const clients = new Map();
  const names = (env.OAUTH_CLIENTS || "").split(",").map(n => n.trim()).filter(Boolean);
  for (const name of names) {
    if (!/^[a-z0-9-]+$/.test(name)) {
      console.warn(`OAUTH_CLIENTS: skipping invalid client name "${name}" (allowed: a-z, 0-9, -)`);
      continue;
    }
    const prefix = `OAUTH_CLIENT_${name.toUpperCase().replace(/-/g, "_")}_`;
    const clientId = env[`${prefix}ID`];
    const clientSecret = env[`${prefix}SECRET`];
    const userId = env[`${prefix}USER_ID`];
    const redirectUri = env[`${prefix}REDIRECT_URI`];
    const missing = [["ID", clientId], ["SECRET", clientSecret], ["USER_ID", userId], ["REDIRECT_URI", redirectUri]]
      .filter(([, value]) => !value)
      .map(([suffix]) => `${prefix}${suffix}`);
    if (missing.length) {
      console.warn(`OAuth client "${name}" is incomplete and will be ignored; missing: ${missing.join(", ")}`);
      continue;
    }
    if (clients.has(clientId)) {
      console.warn(`OAuth client "${name}" ignored: ${prefix}ID duplicates another client's ID`);
      continue;
    }
    clients.set(clientId, { clientSecret, userId, redirectUri });
  }
  return clients;
}

const CLIENTS = loadClients(process.env);
if (CLIENTS.size === 0) {
  console.error("No usable OAuth clients configured. Set OAUTH_CLIENTS and the OAUTH_CLIENT_<NAME>_* keys (see README).");
  process.exit(1);
}

const AUTH_CODE_TTL_MS = 5 * 60 * 1000;
const ACCESS_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// In-memory by design: this is a small, restart-tolerant service. Losing codes/tokens on restart just means re-authorizing.
const AUTH_CODES = new Map();
const ACCESS_TOKENS = new Map();

function base64url(buffer) {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function getBaseUrl(req) {
  return `${req.protocol}://${req.get("host")}`;
}

function getBasicAuthCredentials(req) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Basic ")) return null;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const sepIndex = decoded.indexOf(":");
  if (sepIndex === -1) return null;
  return { clientId: decoded.slice(0, sepIndex), clientSecret: decoded.slice(sepIndex + 1) };
}

const ALL_TOOLS = [
  { name: "get_exercises", description: "Retrieve all default and custom exercises. Each may include a mechanic field ('compound' | 'isolation' | null) used to pick per-mechanic rep defaults.", inputSchema: { type: "object", properties: {} } },
  { name: "get_workout_history", description: "Get lifting logs for a specific date range", inputSchema: { type: "object", properties: { startDate: { type: "string", description: "YYYY-MM-DD" }, endDate: { type: "string", description: "YYYY-MM-DD" } } } },
  { name: "log_lift", description: "Log a lifting exercise session", inputSchema: { type: "object", properties: { date: { type: "string" }, exerciseId: { type: "string" }, sets: { type: "array", items: { type: "object", properties: { weight: { type: "number" }, reps: { type: "number" }, isSkipped: { type: "boolean", description: "Marks this exercise as skipped for the day; when true, weight/reps are omitted" } } } } }, required: ["date", "exerciseId", "sets"] } },
  { name: "get_routines", description: "Get all saved weekly routines", inputSchema: { type: "object", properties: {} } },
  { name: "save_routine", description: "Create a new workout routine or update an existing one. A routine can be assigned to zero or more days of the week.", inputSchema: { type: "object", properties: { id: { type: "number", description: "Internal ID if updating an existing routine. Leave blank for new routines." }, days: { type: "array", items: { type: "string", enum: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] }, description: "Days of the week this routine runs on. Omit or leave empty for an unassigned routine." }, name: { type: "string", description: "Name of the routine (e.g., 'Heavy Legs')" }, exercises: { type: "array", items: { type: "object", properties: { id: { type: "string", description: "The exercise ID" }, sets: { type: "number", default: 3 }, reps: { type: "number", default: 10, description: "Target reps, or the bottom of the range when repMax is set" }, repMax: { type: "number", description: "Top of a rep range; omit for a fixed (non-ranged) target" } }, required: ["id"] } }, cardio: { type: "array", items: { type: "object", properties: { id: { type: ["string", "number"], description: "Optional; auto-generated if omitted. Needed so the app can individually remove this entry." }, type: { type: "string" }, duration: { type: "number", description: "Duration in minutes" }, distance: { type: "number", nullable: true } }, required: ["type", "duration"] } } }, required: ["name"] } },
  { name: "log_cardio", description: "Log a cardio session (Run, Walk, Cycle, etc.)", inputSchema: { type: "object", properties: { date: { type: "string" }, type: { type: "string" }, duration: { type: "number" }, distance: { type: "number" } }, required: ["date", "type", "duration"] } },
  { name: "get_body_metrics", description: "Retrieve body weight and circumference history, optionally filtered to a date range", inputSchema: { type: "object", properties: { startDate: { type: "string", description: "YYYY-MM-DD" }, endDate: { type: "string", description: "YYYY-MM-DD" } } } },
  { name: "log_body_weight", description: "Log morning body weight", inputSchema: { type: "object", properties: { weight: { type: "number" }, date: { type: "string" } }, required: ["weight", "date"] } },
  { name: "add_custom_exercise", description: "Create a new custom exercise", inputSchema: { type: "object", properties: { name: { type: "string", description: "Name of the new exercise" }, mechanic: { type: ["string", "null"], enum: ["compound", "isolation", null], description: "Drives per-mechanic rep defaults; omit or null if not applicable" } }, required: ["name"] } },
  { name: "delete_custom_exercise", description: "Delete a custom exercise by its ID", inputSchema: { type: "object", properties: { id: { type: "number", description: "The ID of the custom exercise to delete" } }, required: ["id"] } },
  { name: "update_log", description: "Update an existing lifting log's date or sets", inputSchema: { type: "object", properties: { id: { type: "number" }, date: { type: "string" }, sets: { type: "array", items: { type: "object", properties: { weight: { type: "number" }, reps: { type: "number" }, isSkipped: { type: "boolean", description: "Marks this exercise as skipped for the day; when true, weight/reps are omitted" } } } } }, required: ["id", "date", "sets"] } },
  { name: "delete_log", description: "Delete a lifting log by ID", inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] } },
  { name: "update_cardio_log", description: "Update an existing cardio log", inputSchema: { type: "object", properties: { id: { type: "number" }, date: { type: "string" }, type: { type: "string" }, duration: { type: "number" }, distance: { type: "number", nullable: true } }, required: ["id", "date", "type", "duration"] } },
  { name: "delete_cardio_log", description: "Delete a cardio log by ID", inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] } },
  { name: "delete_routine", description: "Delete a workout routine by ID", inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] } },
  { name: "log_measurement", description: "Log a body part circumference measurement", inputSchema: { type: "object", properties: { date: { type: "string" }, bodyPart: { type: "string", description: "E.g., Waist, Chest, Left Arm, etc." }, measurement: { type: "number" } }, required: ["date", "bodyPart", "measurement"] } },
  { name: "delete_measurement", description: "Delete a body measurement log by ID", inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] } },
  { name: "delete_body_weight", description: "Delete a body weight log by ID", inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] } },
  { name: "get_daily_override", description: "Check if a specific date has a custom routine override or is set as a rest day. Returns date, routine_id and is_rest; a rest day has is_rest: true and routine_id: null.", inputSchema: { type: "object", properties: { date: { type: "string", description: "Date in YYYY-MM-DD format" } }, required: ["date"] } },
  { name: "set_daily_override", description: "Override the default schedule for a date: either use a specific routine (routineId) or mark the date as a rest day (isRest: true with routineId null or omitted). Replaces any existing override on that date.", inputSchema: { type: "object", properties: { date: { type: "string", description: "Date in YYYY-MM-DD format" }, routineId: { type: ["number", "null"], description: "Positive integer ID of the routine to use for this date. Required unless isRest is true; must be null or omitted for a rest day." }, isRest: { type: "boolean", description: "Set true to mark the date as a rest day (requires routineId null or omitted). Defaults to false." } }, required: ["date"] } },
  { name: "remove_daily_override", description: "Remove a schedule override (a routine override or a rest day), returning the date to its default weekly schedule", inputSchema: { type: "object", properties: { date: { type: "string" } }, required: ["date"] } },
  { name: "get_user_settings", description: "Get the user's unit, display, and progression preferences. Returns an object shaped like update_user_settings' settings argument (weight_unit, measure_unit, distance_unit, timer_increments, show_timer, show_confetti, show_body_weight, show_measurements, progression_enabled, progression_step, default_bar_weight, name, mechanic_rep_defaults).", inputSchema: { type: "object", properties: {} } },
  { name: "update_user_settings", description: "Update the user's settings", inputSchema: { type: "object", properties: { settings: { type: "object", description: "Fields to update -- only the ones provided are changed", properties: { weight_unit: { type: "string", enum: ["lbs", "kg"] }, measure_unit: { type: "string", enum: ["in", "cm"] }, distance_unit: { type: "string", enum: ["mi", "km"] }, timer_increments: { type: "array", items: { type: "number" }, description: "Rest timer quick-select durations, in seconds" }, show_timer: { type: "boolean" }, show_confetti: { type: "boolean" }, show_body_weight: { type: "boolean" }, show_measurements: { type: "boolean" }, progression_enabled: { type: "boolean" }, progression_step: { type: "number", description: "Weight increment suggested by auto-progression" }, default_bar_weight: { type: "number", description: "Unit-less bar weight, in whatever unit weight_unit currently is" }, name: { type: "string", nullable: true, description: "Display name; falls back to the account email when unset" }, mechanic_rep_defaults: { type: "object", nullable: true, description: "Default rep-range targets keyed by exercise mechanic ('compound' | 'isolation')" } } } }, required: ["settings"] } }
];

function createOnyxServer(userId) {
  const server = new Server({
    name: "onyx-connector",
    version: "1.0.0",
  }, {
    capabilities: { tools: {} },
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: ALL_TOOLS
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    try {
      switch (name) {
        case "get_exercises": {
          const [globalRes, customRes] = await Promise.all([
            supabase.from('global_exercises').select('*'),
            supabase.from('custom_exercises').select('*').eq('user_id', userId)
          ]);
          const global = globalRes.data || [];
          const custom = (customRes.data || []).map(e => ({ ...e, id: String(e.id) }));
          const allExercises = [...global, ...custom].sort((a, b) => a.name.localeCompare(b.name));
          return { content: [{ type: "text", text: JSON.stringify(allExercises) }] };
        }
        case "get_workout_history": {
          const liftQuery = applyDateRange(supabase.from('workout_logs').select('*').eq('user_id', userId), args);
          const cardioQuery = applyDateRange(supabase.from('cardio_logs').select('*').eq('user_id', userId), args);
          const [liftsRes, cardioRes] = await Promise.all([ liftQuery.order('date', { ascending: false }), cardioQuery.order('date', { ascending: false }) ]);
          const liftingItems = (liftsRes.data || []).map(item => ({ ...item, dataType: 'lift' }));
          const cardioItems = (cardioRes.data || []).map(item => ({ ...item, dataType: 'cardio' }));
          const combinedHistory = [...liftingItems, ...cardioItems].sort((a, b) => new Date(b.date) - new Date(a.date));
          return { content: [{ type: "text", text: JSON.stringify(combinedHistory) }] };
        }
        case "log_lift": {
          const { error } = await supabase.from('workout_logs').insert([{ user_id: userId, date: args.date, exercise_id: String(args.exerciseId), sets: args.sets }]);
          if (error) throw error;
          return { content: [{ type: "text", text: "Lift logged successfully." }] };
        }
        case "get_routines": {
          const { data } = await supabase.from('routines').select('*').eq('user_id', userId);
          return { content: [{ type: "text", text: JSON.stringify(data) }] };
        }
        case "save_routine": {
          // Mirror RoutineManager.addCardioToRoutine's client-side id generation
          // so cardio entries created via MCP stay individually removable in the UI.
          const cardio = (args.cardio || []).map((c, i) => ({ ...c, id: c.id ?? Date.now() + i }));
          const payload = { user_id: userId, days: args.days || [], name: args.name, exercises: args.exercises || [], cardio };
          let result;
          if (args.id) result = await supabase.from('routines').update(payload).eq('id', args.id).eq('user_id', userId).select();
          else result = await supabase.from('routines').insert([payload]).select();
          if (result.error) throw result.error;
          return { content: [{ type: "text", text: `Routine '${args.name}' saved successfully.` }] };
        }
        case "log_cardio": {
          const { error } = await supabase.from('cardio_logs').insert([{ user_id: userId, date: args.date, type: args.type, duration: args.duration, distance: args.distance }]);
          if (error) throw error;
          return { content: [{ type: "text", text: "Cardio logged successfully." }] };
        }
        case "get_body_metrics": {
          const [weights, measurements] = await Promise.all([
            selectWithRetry(() => applyDateRange(supabase.from('body_weights').select('*').eq('user_id', userId), args)),
            selectWithRetry(() => applyDateRange(supabase.from('circumferences').select('*').eq('user_id', userId), args))
          ]);
          return { content: [{ type: "text", text: JSON.stringify({ weights, measurements }) }] };
        }
        case "log_body_weight": {
          const { error } = await supabase.from('body_weights').insert([{ user_id: userId, date: args.date, weight: args.weight }]);
          if (error) throw error;
          return { content: [{ type: "text", text: "Body weight logged." }] };
        }
        case "add_custom_exercise": {
          const { error } = await supabase.from('custom_exercises').insert([{ user_id: userId, name: args.name, category: 'Custom', mechanic: args.mechanic ?? null }]);
          if (error) throw error;
          return { content: [{ type: "text", text: `Successfully added custom exercise: ${args.name}` }] };
        }
        case "delete_custom_exercise": {
          const { error } = await supabase.from('custom_exercises').delete().eq('id', args.id).eq('user_id', userId);
          if (error) throw error;
          return { content: [{ type: "text", text: `Successfully deleted custom exercise` }] };
        }
        case "update_log": {
          const { error } = await supabase.from('workout_logs').update({ sets: args.sets, date: args.date }).eq('id', args.id).eq('user_id', userId);
          if (error) throw error;
          return { content: [{ type: "text", text: `Lifting log updated successfully.` }] };
        }
        case "delete_log": {
          const { error } = await supabase.from('workout_logs').delete().eq('id', args.id).eq('user_id', userId);
          if (error) throw error;
          return { content: [{ type: "text", text: `Lifting log deleted.` }] };
        }
        case "update_cardio_log": {
          const { error } = await supabase.from('cardio_logs').update({ date: args.date, type: args.type, duration: args.duration, distance: args.distance }).eq('id', args.id).eq('user_id', userId);
          if (error) throw error;
          return { content: [{ type: "text", text: `Cardio log updated successfully.` }] };
        }
        case "delete_cardio_log": {
          const { error } = await supabase.from('cardio_logs').delete().eq('id', args.id).eq('user_id', userId);
          if (error) throw error;
          return { content: [{ type: "text", text: `Cardio log deleted.` }] };
        }
        case "delete_routine": {
          const { error } = await supabase.from('routines').delete().eq('id', args.id).eq('user_id', userId);
          if (error) throw error;
          return { content: [{ type: "text", text: `Routine deleted.` }] };
        }
        case "log_measurement": {
          const { error } = await supabase.from('circumferences').insert([{ user_id: userId, date: args.date, body_part: args.bodyPart, measurement: args.measurement }]);
          if (error) throw error;
          return { content: [{ type: "text", text: `Measurement logged successfully.` }] };
        }
        case "delete_measurement": {
          const { error } = await supabase.from('circumferences').delete().eq('id', args.id).eq('user_id', userId);
          if (error) throw error;
          return { content: [{ type: "text", text: `Measurement deleted.` }] };
        }
        case "delete_body_weight": {
          const { error } = await supabase.from('body_weights').delete().eq('id', args.id).eq('user_id', userId);
          if (error) throw error;
          return { content: [{ type: "text", text: `Body weight log deleted.` }] };
        }
        case "get_daily_override": {
          const { data, error } = await supabase.from('daily_overrides').select(OVERRIDE_SELECT).eq('user_id', userId).eq('date', args.date).maybeSingle();
          if (error && error.code !== 'PGRST116') throw error;
          return { content: [{ type: "text", text: JSON.stringify(formatOverrideResponse(data)) }] };
        }
        case "set_daily_override": {
          const parsed = validateSetOverride(args);
          if (!parsed.ok) return { content: [{ type: "text", text: parsed.error }], isError: true };
          const { error } = await supabase.from('daily_overrides').upsert(buildOverrideRow(userId, parsed));
          if (error) throw error;
          return { content: [{ type: "text", text: setOverrideMessage(parsed) }] };
        }
        case "remove_daily_override": {
          const { error } = await supabase.from('daily_overrides').delete().eq('user_id', userId).eq('date', args.date);
          if (error) throw error;
          return { content: [{ type: "text", text: `Removed custom override.` }] };
        }
        case "get_user_settings": {
          const { data, error } = await supabase.from('user_settings').select('*').eq('user_id', userId).single();
          if (error && error.code !== 'PGRST116') throw error;
          return { content: [{ type: "text", text: JSON.stringify(data || {}) }] };
        }
        case "update_user_settings": {
          const { error } = await supabase.from('user_settings').upsert({ user_id: userId, ...args.settings });
          if (error) throw error;
          return { content: [{ type: "text", text: "User settings updated successfully." }] };
        }
        default:
          throw new Error(`Tool not found: ${name}`);
      }
    } catch (err) {
      return { isError: true, content: [{ type: "text", text: err.message }] };
    }
  });

  return server;
}

app.get("/", (req, res) => {
  res.status(200).send("Onyx MCP Connector is online");
});

app.get("/.well-known/oauth-authorization-server", (req, res) => {
  const baseUrl = getBaseUrl(req);
  res.json({
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/oauth/authorize`,
    token_endpoint: `${baseUrl}/oauth/token`,
    scopes_supported: ["onyx_mcp"],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
    code_challenge_methods_supported: ["S256"],
  });
});

app.get("/.well-known/oauth-protected-resource", (req, res) => {
  const baseUrl = getBaseUrl(req);
  res.json({ resource: baseUrl, authorization_servers: [baseUrl] });
});

app.post("/oauth/register", (req, res) => {
  res.status(400).json({
    error: "invalid_request",
    error_description: "Dynamic client registration is disabled. Configure a Client ID and Client Secret manually in the connector's Advanced settings.",
  });
});

app.get("/oauth/authorize", (req, res) => {
  const { client_id, redirect_uri, state, code_challenge, code_challenge_method } = req.query;

  const client = CLIENTS.get(client_id);
  if (!client || !redirect_uri) {
    console.warn(`/oauth/authorize rejected: ${client ? "missing redirect_uri" : `unknown client_id=${logValue(client_id)}`}`);
    return res.status(400).send("invalid_request");
  }

  if (redirect_uri !== client.redirectUri) {
    // client_id isn't secret, so this is expected to be hit during initial
    // setup (or by a scanner) -- log it so the real callback URL can be
    // read off here and put into OAUTH_CLIENT_<NAME>_REDIRECT_URI, but never redirect
    // to an unlisted URI.
    console.warn(`/oauth/authorize: redirect_uri mismatch for client_id=${logValue(client_id)}. Received: ${logValue(redirect_uri)}`);
    return res.status(400).send("invalid_request");
  }

  const code = crypto.randomBytes(32).toString("hex");
  AUTH_CODES.set(code, {
    clientId: client_id,
    redirectUri: redirect_uri,
    codeChallenge: code_challenge || null,
    expiresAt: Date.now() + AUTH_CODE_TTL_MS,
  });

  const redirectUrl = new URL(redirect_uri);
  redirectUrl.searchParams.set("code", code);
  if (state) redirectUrl.searchParams.set("state", state);
  res.redirect(redirectUrl.toString());
});

app.post("/oauth/token", express.urlencoded({ extended: false }), express.json(), (req, res) => {
  const { grant_type, code, redirect_uri, code_verifier } = req.body;
  const basicAuth = getBasicAuthCredentials(req);
  const client_id = basicAuth ? basicAuth.clientId : req.body.client_id;
  const client_secret = basicAuth ? basicAuth.clientSecret : req.body.client_secret;

  if (grant_type !== "authorization_code") {
    console.warn(`/oauth/token rejected: unsupported grant_type=${logValue(grant_type)}`);
    return res.status(400).json({ error: "unsupported_grant_type" });
  }

  const client = CLIENTS.get(client_id);
  if (!client || !secretsMatch(client.clientSecret, client_secret)) {
    console.warn(`/oauth/token rejected: invalid_client for client_id=${logValue(client_id)}`);
    return res.status(401).json({ error: "invalid_client" });
  }

  const authCode = AUTH_CODES.get(code);
  if (!authCode || authCode.expiresAt < Date.now() || authCode.clientId !== client_id || authCode.redirectUri !== redirect_uri) {
    console.warn(`/oauth/token rejected: invalid_grant for client_id=${logValue(client_id)} (missing/expired/reused code or redirect_uri mismatch)`);
    return res.status(400).json({ error: "invalid_grant" });
  }
  AUTH_CODES.delete(code);

  if (authCode.codeChallenge) {
    const computedChallenge = code_verifier
      ? base64url(crypto.createHash("sha256").update(code_verifier).digest())
      : null;
    if (computedChallenge !== authCode.codeChallenge) {
      console.warn(`/oauth/token rejected: PKCE verification failed for client_id=${logValue(client_id)}`);
      return res.status(400).json({ error: "invalid_grant" });
    }
  }

  const accessToken = crypto.randomBytes(32).toString("hex");
  ACCESS_TOKENS.set(accessToken, { userId: client.userId, expiresAt: Date.now() + ACCESS_TOKEN_TTL_MS });

  res.json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
  });
});

// Shared by every /sse entry point (legacy SSE GET, Streamable HTTP
// POST/DELETE) -- one auth path for the whole MCP surface, per the fix
// this reuses rather than reimplements.
function authenticateRequest(req, res) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const tokenEntry = token && ACCESS_TOKENS.get(token);
  const userId = tokenEntry && tokenEntry.expiresAt > Date.now() ? tokenEntry.userId : null;

  if (!userId) {
    console.warn(`${req.method} ${req.path} rejected: ${token ? "invalid or expired token" : "no bearer token"}`);
    res.set("WWW-Authenticate", `Bearer resource_metadata="${getBaseUrl(req)}/.well-known/oauth-protected-resource"`);
    res.status(401).send("Unauthorized");
    return null;
  }
  return userId;
}

const activeTransports = new Map();

// Legacy HTTP+SSE transport (MCP protocol 2024-11-05): GET opens a
// long-lived stream, subsequent messages arrive via POST /messages/:sessionId.
app.get("/sse", async (req, res) => {
  const userId = authenticateRequest(req, res);
  if (!userId) return;

  const sessionId = crypto.randomUUID();

  const transport = new SSEServerTransport(`/messages/${sessionId}`, res);
  activeTransports.set(sessionId, transport);

  transport.onclose = () => {
    console.log(`Transport closed for session ${sessionId}`);
    activeTransports.delete(sessionId);
  };

  const server = createOnyxServer(userId);

  try {
    await server.connect(transport);
    console.log(`New MCP connection established for user ${userId} (Session: ${sessionId})`);
  } catch (error) {
    console.error("Failed to connect to MCP transport:", error);
    res.status(500).send("MCP Connection Error");
  }
});

app.post("/messages/:sessionId", async (req, res) => {
  const sessionId = req.params.sessionId;
  const transport = activeTransports.get(sessionId);

  if (transport) {
    await transport.handlePostMessage(req, res);
  } else {
    console.warn(`404 Warning: Message received for unknown session: ${logValue(sessionId)}`);
    res.status(404).send("Session not found or expired.");
  }
});

// Streamable HTTP transport (MCP protocol 2025-03-26+): a single endpoint
// that accepts POST with a JSON-RPC body directly, session-scoped via the
// Mcp-Session-Id header instead of a per-session URL. Mounted at both /sse
// (the connector's configured URL) and / (empirically where Claude's
// client actually sends MCP requests, per the request logging -- the
// resource-metadata fix alone didn't change the path it targets). Express
// dispatches by method, so this only ever receives the POST/DELETE
// requests the existing GET /sse and GET / handlers don't.
const streamableTransports = new Map();

async function handleStreamablePost(req, res) {
  const userId = authenticateRequest(req, res);
  if (!userId) return;

  const sessionIdHeader = req.headers["mcp-session-id"];
  let transport;

  if (sessionIdHeader && streamableTransports.has(sessionIdHeader)) {
    const session = streamableTransports.get(sessionIdHeader);
    if (session.userId !== userId) {
      console.warn(`POST ${req.path} rejected: session ${logValue(sessionIdHeader)} does not belong to the authenticated user`);
      return res.status(403).send("Forbidden");
    }
    transport = session.transport;
  } else if (!sessionIdHeader && isInitializeRequest(req.body)) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (sessionId) => {
        console.log(`Streamable HTTP session initialized for user ${userId} (Session: ${sessionId})`);
        streamableTransports.set(sessionId, { transport, userId });
      },
    });

    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) {
        console.log(`Streamable HTTP transport closed for session ${sid}`);
        streamableTransports.delete(sid);
      }
    };

    const server = createOnyxServer(userId);
    await server.connect(transport);
  } else {
    return res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Bad Request: No valid session ID provided" },
      id: null,
    });
  }

  await transport.handleRequest(req, res, req.body);
}

async function handleStreamableDelete(req, res) {
  const userId = authenticateRequest(req, res);
  if (!userId) return;

  const sessionIdHeader = req.headers["mcp-session-id"];
  const session = sessionIdHeader && streamableTransports.get(sessionIdHeader);

  if (!session) {
    return res.status(400).send("No transport found for that session");
  }

  if (session.userId !== userId) {
    console.warn(`DELETE ${req.path} rejected: session ${logValue(sessionIdHeader)} does not belong to the authenticated user`);
    return res.status(403).send("Forbidden");
  }

  await session.transport.handleRequest(req, res);
}

app.post(["/sse", "/"], express.json(), handleStreamablePost);
app.delete(["/sse", "/"], handleStreamableDelete);

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Onyx MCP running on port ${PORT}`));