// modBot.js

// Load environment variables from .env
require("dotenv").config({
  path: require("path").join(__dirname, ".env"),
  quiet: true,
});

// Node built-in file/path tools for modStats.json
const fs = require("fs");
const path = require("path");

// Twitch chat client library
const {
  requireSingleInstance,
  createChatClient,
  safeAsync,
  startBotRuntime,
} = require("./utils/botRuntime");
const { createMessageDeduper } = require("./utils/messageDeduper");

// Custom token refresh function from tokenManager.js
const { ensureValidToken } = require("./tokenManager");

// Shared logger helpers
const { setStatusLine } = require("./utils/logger");

// Text normalisation / fuzzy matching helpers
const { isBlockedVariant } = require("./utils/textNormalise");

// Twitch Helix API helpers
const { deleteMessage, warnUser, timeoutUser } = require("./utils/twitchApi");

// Pull required config from .env
const {
  TWITCH_CHANNEL,
  BOT_USERNAME,
  CLIENT_ID,
  BROADCASTER_ID,
  MODERATOR_ID,
} = process.env;

// Basic required .env validation.
// ACCESS_TOKEN stays on process.env because tokenManager updates it at runtime.
if (
  !TWITCH_CHANNEL ||
  !BOT_USERNAME ||
  !process.env.ACCESS_TOKEN ||
  !CLIENT_ID ||
  !BROADCASTER_ID ||
  !MODERATOR_ID
) {
  console.error("Missing required values in .env");
  console.error("Required:");
  console.error("TWITCH_CHANNEL");
  console.error("BOT_USERNAME");
  console.error("ACCESS_TOKEN");
  console.error("CLIENT_ID");
  console.error("BROADCASTER_ID");
  console.error("MODERATOR_ID");
  process.exit(1);
}

requireSingleInstance("modbot", TWITCH_CHANNEL);
const alreadySeenMessage = createMessageDeduper();

// Main blocked target.
// The normaliser removes spaces/symbols, so "body pillow" becomes "bodypillow".
const target = "bodypillow";

// Set this false to log detections without deleting messages.
const deleteMessages = true;

// Fuzzy matching sensitivity.
// 1 = strict
// 2 = balanced
// 3 = aggressive, higher false-positive risk
const fuzzyDistance = 2;

// Moderation escalation settings.
// First filtered message = delete + Twitch warning.
// Second filtered message = delete + timeout.
const timeoutAfterDeletes = 2;
const timeoutDurationSeconds = 2 * 60;

// File used for long-term moderation stats.
const modStatsPath = path.join(__dirname, "data", "modStats.json");

// Tracks filtered/deleted messages per user for this bot session. Keyed by
// Twitch user ID, not display name, for warning/timeout escalation.
const deletedMessageCounts = new Map();

// Long-term mod stats loaded from data/modStats.json.
// Keyed by Twitch user ID.
let modStats = {};

// Global dashboard counters.
let totalBlockedThisRun = 0;
let totalWarningsThisRun = 0;
let totalTimeoutsThisRun = 0;
let totalDeletesThisRun = 0;

// Twitch client instance gets created after token refresh.
let client;
let runtime;
let shuttingDown = false;

// Main startup flow.
async function startModBot() {
  initialiseDashboard("Starting mod bot...");

  ensureModStatsFile();
  modStats = loadModStats();

  try {
    setStatusLine("MOD", "Token", "Checking bot token...");
    await ensureValidToken("bot");
    setStatusLine("MOD", "Token", "Token ready");
  } catch (error) {
    setStatusLine(
      "MOD",
      "Error",
      `Token check failed: ${error.message || error}`
    );
    setStatusLine("MOD", "Fix", "Try running: node auth.js bot");
    process.exit(1);
  }

  client = createChatClient({
    username: BOT_USERNAME,
    channel: TWITCH_CHANNEL,
    profile: "bot",
  });

  runtime = startBotRuntime({
    prefix: "MOD",
    connections: [
      {
        client,
        channel: TWITCH_CHANNEL,
        profile: "bot",
      },
    ],
    onFatal: fatalModBot,
  });

  setupModEvents();

  try {
    setStatusLine(
      "MOD",
      "Connection",
      `Connecting to #${TWITCH_CHANNEL} as ${BOT_USERNAME}...`
    );
    await client.connect();
  } catch (error) {
    setStatusLine(
      "MOD",
      "Error",
      `Failed to connect to Twitch chat: ${error.message || error}`
    );
    process.exit(1);
  }
}

startModBot().catch(fatalModBot);

// Sets up the initial fixed dashboard lines.
// These same lines get updated instead of endlessly printing new ones.
function initialiseDashboard(statusMessage) {
  setStatusLine("MOD", "Status", statusMessage);
  setStatusLine("MOD", "Connection", "Not connected yet");
  setStatusLine("MOD", "Token", "Waiting");
  setStatusLine(
    "MOD",
    "Config",
    `Target="${target}", delete=${deleteMessages ? "ON" : "OFF"}, ` +
      `fuzzy=${fuzzyDistance}`
  );
  setStatusLine(
    "MOD",
    "Escalation",
    `1st filtered message = warning, ${timeoutAfterDeletes}nd = ` +
      `${timeoutDurationSeconds}s timeout`
  );
  setStatusLine("MOD", "Stats File", modStatsPath);
  setStatusLine(
    "MOD",
    "Totals",
    "blocked=0, deleted=0, warnings=0, timeouts=0"
  );
  setStatusLine("MOD", "Last Blocked", "None yet");
  setStatusLine("MOD", "Last Reason", "None yet");
  setStatusLine("MOD", "Last Action", "None yet");
  setStatusLine("MOD", "Session User", "None yet");
  setStatusLine("MOD", "Long-Term User", "None yet");
  setStatusLine("MOD", "Error", "None");
}

// Makes sure data/modStats.json exists and contains valid JSON.
function ensureModStatsFile() {
  const dataDir = path.dirname(modStatsPath);

  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  if (!fs.existsSync(modStatsPath)) {
    fs.writeFileSync(modStatsPath, "{}\n", "utf8");
  }
}

// Loads data/modStats.json.
// If the file is broken, the bot does not delete it. It exits so you can inspect/fix it.
function loadModStats() {
  try {
    const raw = fs.readFileSync(modStatsPath, "utf8").trim();

    if (!raw) {
      return {};
    }

    return JSON.parse(raw);
  } catch (error) {
    setStatusLine(
      "MOD",
      "Error",
      `Failed to load modStats.json: ${error.message || error}`
    );
    setStatusLine("MOD", "Fix", "Fix data/modStats.json or replace it with {}");
    process.exit(1);
  }
}

// Saves data/modStats.json using an atomic-ish write.
// Writes to a temp file first, then renames it over the real file.
function saveModStats() {
  try {
    const tempPath = `${modStatsPath}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(modStats, null, 2)}\n`, "utf8");
    fs.renameSync(tempPath, modStatsPath);
  } catch (error) {
    setStatusLine(
      "MOD",
      "Error",
      `Failed to save modStats.json: ${error.message || error}`
    );
  }
}

// Returns the user's mod stats entry, creating it if needed.
function getOrCreateModStatsEntry(userId, username, displayName) {
  if (!userId) {
    return null;
  }

  if (!modStats[userId]) {
    modStats[userId] = {
      username: username || "unknown",
      displayName: displayName || username || "unknown",
      blockedMessages: 0,
      warnings: 0,
      timeouts: 0,
      firstOffenceAt: null,
      lastOffenceAt: null,
      lastReason: null,
      lastMessage: null,
    };
  }

  // Keep names fresh in case the user changes display name/capitalisation.
  modStats[userId].username = username || modStats[userId].username || "unknown";
  modStats[userId].displayName =
    displayName || modStats[userId].displayName || username || "unknown";

  return modStats[userId];
}

// Records that the user triggered the blocked filter.
function recordBlockedMessage(userId, username, displayName, message, reason) {
  const entry = getOrCreateModStatsEntry(userId, username, displayName);

  if (!entry) {
    return null;
  }

  const now = new Date().toISOString();

  entry.blockedMessages += 1;

  if (!entry.firstOffenceAt) {
    entry.firstOffenceAt = now;
  }

  entry.lastOffenceAt = now;
  entry.lastReason = reason;
  entry.lastMessage = message;

  saveModStats();

  return entry;
}

// Records that the user received a Twitch warning.
function recordWarning(userId, username, displayName) {
  const entry = getOrCreateModStatsEntry(userId, username, displayName);

  if (!entry) {
    return null;
  }

  entry.warnings += 1;
  entry.lastWarningAt = new Date().toISOString();

  saveModStats();

  return entry;
}

// Records that the user received a timeout.
function recordTimeout(userId, username, displayName, durationSeconds, reason) {
  const entry = getOrCreateModStatsEntry(userId, username, displayName);

  if (!entry) {
    return null;
  }

  entry.timeouts += 1;
  entry.lastTimeoutAt = new Date().toISOString();
  entry.lastTimeoutDurationSeconds = durationSeconds;
  entry.lastTimeoutReason = reason;

  saveModStats();

  return entry;
}

// Updates the overall totals line.
function updateTotalsLine() {
  setStatusLine(
    "MOD",
    "Totals",
    `blocked=${totalBlockedThisRun}, deleted=${totalDeletesThisRun}, ` +
      `warnings=${totalWarningsThisRun}, timeouts=${totalTimeoutsThisRun}`
  );
}

// Attaches Twitch chat event handlers.
function setupModEvents() {
  client.on("connected", () => {
    setStatusLine("MOD", "Status", "Running");
    setStatusLine(
      "MOD",
      "Connection",
      `Connected to #${TWITCH_CHANNEL} as ${BOT_USERNAME}`
    );
    setStatusLine("MOD", "Token", "Ready");
    setStatusLine("MOD", "Error", "None");
  });

  client.on(
    "message",
    safeAsync(
      "MOD",
      "Chat handler failed",
      async (channel, tags, message, self) => {
        if (shuttingDown || alreadySeenMessage(tags.id)) {
          return;
        }

        // Ignore messages sent by this bot connection.
        if (self) {
          return;
        }

        // Also ignore this bot account by username in case another process
        // using the same account sends something.
        if ((tags.username || "").toLowerCase() === BOT_USERNAME.toLowerCase()) {
          return;
        }

        const username = tags.username || "unknown";
        const displayName = tags["display-name"] || username;
        const user = displayName || username || "unknown";
        const userId = tags["user-id"];
        const messageId = tags.id;

        // Check whether the message matches the blocked term or a bypass.
        const result = isBlockedVariant(message, target, fuzzyDistance);

        if (!result.blocked) {
          return;
        }

        totalBlockedThisRun += 1;
        updateTotalsLine();

        const statsEntry = recordBlockedMessage(
          userId,
          username,
          displayName,
          message,
          result.reason
        );

        setStatusLine("MOD", "Last Blocked", `${user}: ${message}`);
        setStatusLine("MOD", "Last Reason", result.reason);

        if (statsEntry) {
          setStatusLine(
            "MOD",
            "Long-Term User",
            `${user}: blocked=${statsEntry.blockedMessages}, ` +
              `warnings=${statsEntry.warnings}, ` +
              `timeouts=${statsEntry.timeouts}`
          );
        }

        // Detection-only mode.
        if (!deleteMessages) {
          setStatusLine("MOD", "Last Action", "Detected only. Delete mode is OFF.");
          return;
        }

        try {
          // Delete the offending Twitch message.
          await deleteMessage({
            messageId,
            broadcasterId: BROADCASTER_ID,
            moderatorId: MODERATOR_ID,
            tokenProfile: "bot",
            clientId: CLIENT_ID,
          });

          totalDeletesThisRun += 1;
          updateTotalsLine();

          setStatusLine("MOD", "Last Action", `Deleted message from ${user}`);

          // Increment this user's filtered-message count for this session.
          const deleteCount = incrementDeletedMessageCount(userId);

          if (deleteCount > 0) {
            setStatusLine(
              "MOD",
              "Session User",
              `${user}: ${deleteCount} filtered message(s) this session`
            );
          }

          // First offence this session: Twitch warning popup.
          if (deleteCount === 1) {
            await warnUser({
              userId,
              reason:
                "Please stop using blocked terms. Repeating this will result " +
                "in a timeout.",
              broadcasterId: BROADCASTER_ID,
              moderatorId: MODERATOR_ID,
              tokenProfile: "bot",
              clientId: CLIENT_ID,
            });

            totalWarningsThisRun += 1;
            updateTotalsLine();

            const updatedStats = recordWarning(userId, username, displayName);

            setStatusLine("MOD", "Last Action", `Warned ${user}`);

            if (updatedStats) {
              setStatusLine(
                "MOD",
                "Long-Term User",
                `${user}: blocked=${updatedStats.blockedMessages}, ` +
                  `warnings=${updatedStats.warnings}, ` +
                  `timeouts=${updatedStats.timeouts}`
              );
            }
          }

          // Second offence this session: timeout.
          if (deleteCount >= timeoutAfterDeletes) {
            const timeoutReason =
              `Triggered blocked term filter ${deleteCount} times`;

            await timeoutUser({
              userId,
              durationSeconds: timeoutDurationSeconds,
              reason: timeoutReason,
              broadcasterId: BROADCASTER_ID,
              moderatorId: MODERATOR_ID,
              tokenProfile: "bot",
              clientId: CLIENT_ID,
            });

            totalTimeoutsThisRun += 1;
            updateTotalsLine();

            const updatedStats = recordTimeout(
              userId,
              username,
              displayName,
              timeoutDurationSeconds,
              timeoutReason
            );

            setStatusLine(
              "MOD",
              "Last Action",
              `Timed out ${user} for ${timeoutDurationSeconds}s after ` +
                `${deleteCount} filtered messages`
            );

            if (updatedStats) {
              setStatusLine(
                "MOD",
                "Long-Term User",
                `${user}: blocked=${updatedStats.blockedMessages}, ` +
                  `warnings=${updatedStats.warnings}, ` +
                  `timeouts=${updatedStats.timeouts}`
              );
            }

            // Reset after timeout so the next offence starts a fresh cycle.
            resetDeletedMessageCount(userId);
          }

          setStatusLine("MOD", "Error", "None");
        } catch (error) {
          setStatusLine(
            "MOD",
            "Error",
            `Failed to delete/warn/timeout ${user}: ${error.message || error}`
          );
        }
      }
    )
  );
}

// Adds one to the user's deleted-message count for this bot session.
function incrementDeletedMessageCount(userId) {
  if (!userId) {
    return 0;
  }

  const currentCount = deletedMessageCounts.get(userId) || 0;
  const newCount = currentCount + 1;

  deletedMessageCounts.set(userId, newCount);

  return newCount;
}

// Clears a user's deleted-message count.
// Used after timeout.
function resetDeletedMessageCount(userId) {
  if (!userId) {
    return;
  }

  deletedMessageCounts.delete(userId);
}

function fatalModBot(error) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  runtime?.stop();
  setStatusLine("MOD", "Fatal", error?.message || String(error));

  // Moderation stats are already saved after each successful action.
  process.exit(1);
}

async function shutdownModBot() {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  runtime?.stop();
  setTimeout(() => process.exit(0), 5_000).unref();

  try {
    if (client) {
      await client.disconnect();
    }
  } catch {
    // Already disconnected.
  }

  process.exit(0);
}

process.on("SIGINT", shutdownModBot);
process.on("SIGTERM", shutdownModBot);
process.on("uncaughtException", fatalModBot);
process.on("unhandledRejection", fatalModBot);
