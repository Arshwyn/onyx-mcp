import { secretsMatch } from "./security.js";

// Pure handlers for the token endpoint so they can be tested without starting
// the server. Each returns { status, body }.

export function authenticateClient(clients, clientId, clientSecret) {
  const client = clients.get(clientId);
  if (!client || !secretsMatch(client.clientSecret, clientSecret)) return null;
  return client;
}

export function tokenResponse(tokens) {
  return {
    access_token: tokens.accessToken,
    token_type: "Bearer",
    expires_in: tokens.expiresIn,
    refresh_token: tokens.refreshToken,
  };
}

export function handleRefreshGrant({ store, clients, clientId, clientSecret, refreshToken }) {
  if (!authenticateClient(clients, clientId, clientSecret)) {
    return { status: 401, body: { error: "invalid_client" }, reason: "invalid_client" };
  }
  if (typeof refreshToken !== "string" || !refreshToken) {
    return { status: 400, body: { error: "invalid_request" }, reason: "missing refresh_token" };
  }
  const result = store.refresh(refreshToken, clientId);
  if (result.error) {
    return { status: 400, body: { error: "invalid_grant" }, reason: "invalid_grant" };
  }
  return { status: 200, body: tokenResponse(result) };
}
