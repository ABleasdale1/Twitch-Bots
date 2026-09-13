// utils/twitchApi.js
const { ensureValidToken, getAccessToken } = require("../tokenManager");

// Reload the shared token for each API call; other bot processes may have
// rotated it. Only retry a definite 401, never an ambiguous failed POST.
async function fetchWithAuth(url, options, { tokenProfile, accessToken }) {
  let token = tokenProfile ? getAccessToken(tokenProfile) : accessToken;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch(url, {
      ...options,
      headers: { ...options.headers, Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status !== 401 || !tokenProfile || attempt === 1) return response;
    if (response.body) await response.body.cancel();
    token = (await ensureValidToken(tokenProfile)).accessToken;
  }
}

// Deletes a specific Twitch chat message by message ID.
// Requires moderator:manage:chat_messages scope.
async function deleteMessage({
  messageId,
  broadcasterId,
  moderatorId,
  accessToken,
  tokenProfile,
  clientId,
}) {
  if (!messageId) {
    throw new Error("Missing Twitch message ID");
  }

  const url = new URL("https://api.twitch.tv/helix/moderation/chat");

  url.searchParams.set("broadcaster_id", broadcasterId);
  url.searchParams.set("moderator_id", moderatorId);
  url.searchParams.set("message_id", messageId);

  const res = await fetchWithAuth(url, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Client-Id": clientId,
    },
  }, { tokenProfile, accessToken });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
}

// Sends a Twitch warning popup.
// The user must acknowledge it before chatting again.
// Requires moderator:manage:warnings scope.
async function warnUser({
  userId,
  reason = "You have been warned for using blocked terms. Repeating this will result in a timeout.",
  broadcasterId,
  moderatorId,
  accessToken,
  tokenProfile,
  clientId,
}) {
  if (!userId) {
    throw new Error("Missing Twitch user ID for warning");
  }

  const url = new URL("https://api.twitch.tv/helix/moderation/warnings");

  url.searchParams.set("broadcaster_id", broadcasterId);
  url.searchParams.set("moderator_id", moderatorId);

  const res = await fetchWithAuth(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Client-Id": clientId,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      data: {
        user_id: userId,
        reason,
      },
    }),
  }, { tokenProfile, accessToken });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
}

// Times out a user for a set duration.
// This uses Twitch's bans endpoint, but because duration is included, it is a timeout, not a permanent ban.
// Requires moderator:manage:banned_users scope.
async function timeoutUser({
  userId,
  durationSeconds,
  reason = "Repeated blocked terms",
  broadcasterId,
  moderatorId,
  accessToken,
  tokenProfile,
  clientId,
}) {
  if (!userId) {
    throw new Error("Missing Twitch user ID for timeout");
  }

  const url = new URL("https://api.twitch.tv/helix/moderation/bans");

  url.searchParams.set("broadcaster_id", broadcasterId);
  url.searchParams.set("moderator_id", moderatorId);

  const res = await fetchWithAuth(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Client-Id": clientId,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      data: {
        user_id: userId,

        // IMPORTANT:
        // duration makes this a timeout.
        // Without duration, Twitch treats it as a permanent ban.
        duration: durationSeconds,

        reason,
      },
    }),
  }, { tokenProfile, accessToken });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
}

// Checks Twitch Helix API to see whether the broadcaster is live.
// Returns true if live, false if offline.
async function isStreamLive({ broadcasterId, accessToken, tokenProfile, clientId }) {
  const url = new URL("https://api.twitch.tv/helix/streams");
  url.searchParams.set("user_id", broadcasterId);

  const res = await fetchWithAuth(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Client-Id": clientId,
    },
  }, { tokenProfile, accessToken });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Live check failed: ${res.status} ${res.statusText}: ${text}`);
  }

  const data = await res.json();

  // Twitch returns an empty data array when the user is offline.
  return Array.isArray(data.data) && data.data.length > 0;
}

module.exports = {
  deleteMessage,
  warnUser,
  timeoutUser,
  isStreamLive,
  fetchWithAuth,
};