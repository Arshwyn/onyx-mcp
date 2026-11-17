# onyx-mcp

An MCP (Model Context Protocol) server that exposes a Supabase-backed Onyx
workout tracker to MCP clients such as a claude.ai custom connector. It
provides tools to read and write exercises, lifting and cardio logs,
routines, body weight, measurements, daily overrides (a routine override or
a rest day) and user settings.
Access is protected by an OAuth 2.0 authorization-code flow with required PKCE (S256 only) and
rotating refresh tokens; each configured client is bound to one Supabase user.

## Prerequisites

- Node.js 24+ (or Docker)
- A Supabase project with these tables: `global_exercises`, `custom_exercises`,
  `workout_logs`, `cardio_logs`, `routines`, `body_weights`, `circumferences`,
  `daily_overrides`, `user_settings`. Per-user rows are scoped by a `user_id`
  column. `daily_overrides` must include the `is_rest` boolean column
  (`routine_id` nullable) and the `daily_overrides_rest_xor_routine` check
  constraint, as added by the Onyx migration
  `202610300000_daily_overrides_is_rest.sql`. This repo ships no migration.
- The project's service role key.

## Configuration

Set these in `.env` (see `.env.example`).

| Variable | Required | Description |
| --- | --- | --- |
| `SUPABASE_URL` | yes | Supabase project URL. `VITE_SUPABASE_URL` is accepted as a fallback. |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Service role key. |
| `OAUTH_CLIENTS` | yes | Comma-separated client names matching `^[a-z0-9-]+$`, e.g. `alice,bob`. |
| `OAUTH_CLIENT_<N>_ID` | per client | OAuth client ID. `<N>` is the name uppercased with `-` replaced by `_`. |
| `OAUTH_CLIENT_<N>_SECRET` | per client | OAuth client secret (e.g. `openssl rand -hex 32`). |
| `OAUTH_CLIENT_<N>_USER_ID` | per client | Supabase user UUID this client acts as. |
| `OAUTH_CLIENT_<N>_REDIRECT_URI` | per client | Exact callback URL of the connector. |
| `CORS_ALLOWED_ORIGINS` | no | Comma-separated exact origins allowed to make cross-origin browser requests, e.g. `https://app.example.com`. Default empty: no CORS headers at all. Origins only (`https://host[:port]`, or `http://localhost[:port]`); no paths, trailing slashes or wildcards. An invalid entry stops startup. |
| `PORT` | no | Listen port when run with `npm start`, default `10000`. With Docker Compose it only sets the host port; the container always listens on 10000. |
| `BIND_ADDR` | no | Docker Compose only (`npm start` and bare `node` ignore it): host interface the published port binds to. Unset or empty means all interfaces, the same as before. Set a LAN address for LAN-only access, or `127.0.0.1` when a reverse proxy or tunnel runs on the same host. A loopback bind breaks a tunnel or proxy that reaches the container through the host's LAN address. Bracket IPv6 literals, e.g. `[::1]`. |

The server exits with an error if the Supabase settings are missing or no
client is fully configured. An incomplete client is skipped with a warning
that names the missing keys (never their values).

## Migrating from older versions

Earlier versions read per-person variables such as `AUTH_TOKEN_ALICE`,
`AUTH_USER_ID_ALICE` and `AUTH_REDIRECT_URI_ALICE`. These are no longer read;
if they are the only client config, the server exits with code 1 at startup
because no clients are configured. Before upgrading, add to `.env`:

```
OAUTH_CLIENTS=alice,bob
OAUTH_CLIENT_ALICE_ID=<existing client id>
OAUTH_CLIENT_ALICE_SECRET=<value of AUTH_TOKEN_ALICE>
OAUTH_CLIENT_ALICE_USER_ID=<value of AUTH_USER_ID_ALICE>
OAUTH_CLIENT_ALICE_REDIRECT_URI=<value of AUTH_REDIRECT_URI_ALICE>
```

and the same four keys for each other client. Keep the old variables until the
upgrade is verified if you may need to roll back. `VITE_SUPABASE_URL` still
works as a fallback for `SUPABASE_URL`.

## Run locally

Requires Node 24 or newer, for both `npm ci` and `npm start`.

```
cp .env.example .env   # then edit
npm ci
npm start
```

## Run with Docker

```
docker compose up -d --build
```

The image is built on `node:24.22.2-trixie-slim` (Node 24 on Debian 13 slim),
pinned to an exact version. To pick up base image patches, rebuild with
`docker compose build --pull` and restart. The runtime image is built in two
stages and contains only `node` and the app: npm, npx and corepack are removed
from it. The image tag is `onyx-mcp:latest`
by default; to use another tag set `IMAGE_TAG` in the shell (optional), for
example `IMAGE_TAG=1.2.3 docker compose up -d --build`. Prefer the shell over
`.env`, because Compose passes every `.env` key into the container.

To restrict which host interface publishes the port, set `BIND_ADDR` (optional,
Compose only), for example `BIND_ADDR=192.0.2.10 docker compose up -d` for a
LAN address, or `BIND_ADDR=127.0.0.1` when a proxy or tunnel runs on the same
host. Unset or empty publishes on all interfaces, exactly as before. Bracket
IPv6 literals (`BIND_ADDR=[::1]`). As with `IMAGE_TAG`, prefer the shell over
`.env`, because Compose passes every `.env` key into the container. A loopback
bind is unreachable for a tunnel or proxy that connects via the host's LAN
address.

A `.env` file must exist next to `docker-compose.yml`, otherwise `docker compose up` fails. Compose reads it via `env_file`, so any `OAUTH_CLIENT_*` key is passed
through, so keep only application variables in that file. The container listens on 10000; the host port is `${PORT:-10000}`.

The container is hardened: it runs as the unprivileged `node` user (uid 1000),
with a read-only root filesystem, all Linux capabilities dropped and
`no-new-privileges` set. The only thing the app writes is the token store (see
[Tokens and persistence](#tokens-and-persistence)), on the named volume
`onyx-mcp-data` mounted at `/data`; no tmpfs is needed. Compose also defines a health check that runs `node` to request
`http://127.0.0.1:10000/` and fails on a non-200 response.

## TLS

Run the server behind a reverse proxy or tunnel that terminates TLS and sets
`X-Forwarded-Proto`. The server sets `trust proxy`, so OAuth discovery URLs use
the public scheme and host of each request. Do not expose the plain HTTP port
directly to the internet.

## Connecting a claude.ai custom connector

1. Add a custom connector pointing at `https://mcp.example.com/sse` (your
   public URL).
2. In Advanced settings enter the client ID and client secret from your `.env`.
3. Start the connection. If `OAUTH_CLIENT_<N>_REDIRECT_URI` is not yet set or
   is wrong, the server logs `redirect_uri mismatch ... Received: "<url>"`
   (the URL is JSON-quoted); copy the URL without the quotes into the variable
   and restart.

PKCE is required (OAuth 2.1 and the MCP authorization spec): `/oauth/authorize`
needs a `code_challenge` with `code_challenge_method=S256`, otherwise it
redirects back with `error=invalid_request`, and `/oauth/token` always checks
the `code_verifier` against it. `plain` is not accepted. Refresh grants are
not affected, and existing tokens keep working.

Server-side connectors make no cross-origin browser requests and need no CORS
configuration. A browser-based client must have its exact origin added to
`CORS_ALLOWED_ORIGINS` (then restart).

## Tokens and persistence

The token endpoint supports the `authorization_code` and `refresh_token`
grants (advertised in the discovery metadata). A successful code exchange
returns a short-lived access token (1 hour) and a refresh token (90 days).
Presenting the refresh token with the same client credentials returns a new
access token and a new refresh token; the old refresh token stops working
(rotation), and the 90-day lifetime restarts on each refresh. Reusing an
already-rotated refresh token is rejected and ends that session. Connectors
that support refresh therefore stay signed in without manual reconnects.

Access and refresh tokens are stored as SHA-256 hashes in a small JSON file
(`/data/tokens.json`, mode 0600; override with `TOKEN_STORE_PATH`) on the
`onyx-mcp-data` volume, so restarts and redeploys keep sessions. Raw tokens are
never written to disk. Authorization codes stay in memory (5 minutes). If the
file cannot be read or written, the server logs a warning and keeps tokens in
memory only, so a restart then requires re-authorizing. A file that cannot be
parsed is left untouched.

To sign every client out, stop the stack and delete the volume
(`docker compose down -v`) or just `tokens.json`. Do not use `down -v` for
routine redeploys. The file lives on a volume rather than in Supabase to avoid
a new table and extra database privileges for a small, single-instance service.

## Daily overrides

A date can have one override per user: either a routine or a rest day.

- `set_daily_override` takes `date` (`YYYY-MM-DD`), `routineId` (positive
  integer or null) and `isRest` (boolean, default `false`). With a `routineId`
  and `isRest` false or omitted it sets a routine override. With
  `isRest: true` and `routineId` null or omitted it marks a rest day. It
  replaces whatever override the date already holds. These are rejected with
  an error before the database is touched: `isRest: true` together with a
  `routineId`; no `routineId` without `isRest: true`; a `routineId` that is
  not a positive integer; a `date` that is not a valid `YYYY-MM-DD`.
- `get_daily_override` returns `date`, `routine_id` and `is_rest`. A rest day
  has `is_rest: true` and `routine_id: null`. A date without an override
  returns a "No override found" message.
- `remove_daily_override` deletes the row, clearing either a routine override
  or a rest day.

## Testing

```
npm test
```

Runs the unit tests with the built-in Node test runner. They use fakes and
need no `.env` or database. Node 24 or newer is required: on older Node the
quoted test glob is not expanded and the run fails.

## Endpoints

- `GET /` health check
- `GET /.well-known/oauth-authorization-server`, `GET /.well-known/oauth-protected-resource`
- `POST /oauth/register`, `GET /oauth/authorize`, `POST /oauth/token` (authorization code and refresh grants; the authorization code grant requires PKCE)
- `GET /sse` and `POST /messages/:sessionId` (SSE transport)
- `POST /` and `POST /sse` (streamable HTTP transport)

CORS applies to all routes through the `CORS_ALLOWED_ORIGINS` allowlist.

## Security notes

- The container runs as a non-root user with a read-only root filesystem,
  all capabilities dropped and `no-new-privileges` enabled.
- The service role key bypasses RLS; the server enforces per-user scoping by
  `user_id`. Keep `.env` private and out of version control.
- `.env` should hold only the variables this app uses: Compose passes every
  key in it to the container.
- The server sets `trust proxy`, so it trusts `X-Forwarded-*` headers from
  any client. The reverse proxy or tunnel must be the only network route to
  the server port; otherwise those headers can be spoofed.
- To rotate the Supabase service role key, generate a new one in the Supabase
  dashboard, update `SUPABASE_SERVICE_ROLE_KEY` in `.env`, and restart the
  server (`docker compose up -d`). Revoke the old key afterwards.
- Client-supplied values written to logs (client ID, redirect URI, grant
  type, session IDs) are JSON-quoted so they cannot inject extra log lines.
- Request logging records method and path only; headers, bodies and secrets
  are never logged.
- Every response carries `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY` and
  `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`.
  `/oauth/*` responses also send `Cache-Control: no-store`. The
  `X-Powered-By` header is removed.
- CORS is off by default. When `CORS_ALLOWED_ORIGINS` is set, only those exact
  origins get `Access-Control-Allow-Origin` (never `*`, never credentials, no
  reflection of other origins) and responses send `Vary: Origin`.
- HSTS is not set by the app; configure it on the TLS-terminating reverse
  proxy, which should also not re-add `X-Powered-By` or a wildcard CORS header.
