// lvlBot.js

require("dotenv").config({ path: require("path").join(__dirname, ".env"), quiet: true });

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { requireSingleInstance, createChatClient, safeAsync, startBotRuntime } = require("./utils/botRuntime");
const { createMessageDeduper } = require("./utils/messageDeduper");

const { ensureValidToken } = require("./tokenManager");
const { setStatusLine } = require("./utils/logger");

const { TWITCH_CHANNEL, BOT_USERNAME } = process.env;

if (!TWITCH_CHANNEL || !BOT_USERNAME || !process.env.ACCESS_TOKEN) {
  console.error("Missing required values in .env");
  console.error("Required:");
  console.error("TWITCH_CHANNEL");
  console.error("BOT_USERNAME");
  console.error("ACCESS_TOKEN");
  process.exit(1);
}

requireSingleInstance("lvlbot", TWITCH_CHANNEL);
const alreadySeenMessage = createMessageDeduper();

// -----------------------------------------------------------------------------
// Paths
// -----------------------------------------------------------------------------

const DATA_DIRECTORY = path.join(__dirname, "data");
const LEVELS_PATH = path.join(DATA_DIRECTORY, "lvls.json");
const ADMIN_COMMANDS_PATH = path.join(
  DATA_DIRECTORY,
  "admin-commands.txt"
);

const XP_BOOST_PATH = path.join(
  DATA_DIRECTORY,
  "xp-boost.json"
);

// How often the bot checks admin-commands.txt.
const ADMIN_COMMAND_POLL_MS = 1000;

// -----------------------------------------------------------------------------
// XP configuration
// -----------------------------------------------------------------------------

const MIN_XP_PER_MESSAGE = 5;
const MAX_XP_PER_MESSAGE = 10;
const XP_COOLDOWN_MS = 10 * 1000;
const MIN_MESSAGE_LENGTH = 5;
const ANNOUNCE_LEVEL_UPS = true;
const TOP_LIMIT = 5;

// -----------------------------------------------------------------------------
// Daily reward settings.
// -----------------------------------------------------------------------------
const DAILY_MIN_XP = 100;
const DAILY_MAX_XP = 250;
const DAILY_COOLDOWN_MS = 24 * 60 * 60 * 1000;

// -----------------------------------------------------------------------------
// Temporary XP boost settings
// -----------------------------------------------------------------------------

const MIN_XP_BOOST_MULTIPLIER = 1;
const MAX_XP_BOOST_MULTIPLIER = 100;
const MAX_XP_BOOST_DURATION_MS =
  30 * 24 * 60 * 60 * 1000;

// False means !daily rewards are not multiplied.
const XP_BOOST_APPLIES_TO_DAILY = false;

// -----------------------------------------------------------------------------
// Known bots that should not receive XP
// -----------------------------------------------------------------------------

const BOT_USERNAMES = new Set([
  BOT_USERNAME.toLowerCase(),

  // Broadcaster
  "sketchy_sally",

  // Custom bots
  "rynoxbot",
  "sallyssimpbot",
  "sallysanointedone",

  // Bots currently in the channel
  "pokemoncommunitygame",
  "soundalerts",
  "streamelements",
  "streamlabs",
  "tangiabot",

  // Common Twitch bots
  "nightbot",
  "moobot",
  "fossabot",
  "sery_bot",
  "wizebot",
]);

// -----------------------------------------------------------------------------
// Runtime state
// -----------------------------------------------------------------------------

let levels = {};
let client;
let runtime;
let levelDataLoaded = false;
let xpBoostDataLoaded = false;

let terminalCommandsStarted = false;
let adminCommandPollInProgress = false;
let shuttingDown = false;

let xpEventsThisRun = 0;
let commandsHandledThisRun = 0;
let levelUpsThisRun = 0;
let failedSavesThisRun = 0;

let xpBoost = {
  multiplier: 1,
  startedAt: 0,
  endsAt: 0,
  startedBy: null,
};

// -----------------------------------------------------------------------------
// Startup
// -----------------------------------------------------------------------------

async function startLevelBot() {
  initialiseDashboard("Starting level bot...");

  ensureDataFiles();

  levels = loadLevels();
  levelDataLoaded = true;
  repairLoadedLevelData();

  xpBoost = loadXpBoost();
  xpBoostDataLoaded = true;
  clearExpiredXpBoost();

  updateTotalsLine();
  updateXpBoostStatusLine();

  try {
    setStatusLine("LEVEL", "Token", "Checking bot token...");

    await ensureValidToken("bot");

    setStatusLine("LEVEL", "Token", "Token ready");
  } catch (error) {
    setStatusLine(
      "LEVEL",
      "Error",
      `Token refresh failed: ${formatError(error)}`
    );

    setStatusLine(
      "LEVEL",
      "Fix",
      "Try running: node auth.js bot"
    );

    process.exit(1);
  }

  client = createChatClient({ username: BOT_USERNAME, channel: TWITCH_CHANNEL, profile: "bot" });
  runtime = startBotRuntime({
    prefix: "LEVEL", connections: [{ client, channel: TWITCH_CHANNEL, profile: "bot" }],
    onFatal: fatalLevelBot,
  });

  setupLevelEvents();
  setupTerminalCommands();
  setupAdminCommandFile();

  setStatusLine("LEVEL", "Connection", `Connecting to #${TWITCH_CHANNEL} as ${BOT_USERNAME}...`);
  // Only tmi owns reconnect attempts. A failed initial login exits to systemd.
  await client.connect();
}

startLevelBot().catch(fatalLevelBot);

// -----------------------------------------------------------------------------
// Dashboard
// -----------------------------------------------------------------------------

function initialiseDashboard(statusMessage) {
  setStatusLine("LEVEL", "Status", statusMessage);
  setStatusLine("LEVEL", "Connection", "Not connected yet");
  setStatusLine("LEVEL", "Token", "Waiting");

  setStatusLine(
    "LEVEL",
    "XP Boost",
    "Loading..."
  );

  setStatusLine(
    "LEVEL",
    "Config",
    `${MIN_XP_PER_MESSAGE}-${MAX_XP_PER_MESSAGE} XP/msg, ` +
      `cooldown=${Math.round(XP_COOLDOWN_MS / 1000)}s, ` +
      `minLength=${MIN_MESSAGE_LENGTH}`
  );

  setStatusLine("LEVEL", "Levels File", LEVELS_PATH);

  setStatusLine(
    "LEVEL",
    "Admin File",
    `${ADMIN_COMMANDS_PATH} — one command per line`
  );

  setStatusLine(
    "LEVEL",
    "Chat Commands",
    "!level | !lvl | !xp | !rank | !topyappers | !daily"
  );

  setStatusLine(
    "LEVEL",
    "Mod Commands",
    "!addxp | !removexp | !setxp | !setlevel | !resetlevel"
  );

  setStatusLine(
    "LEVEL",
    "Local Commands",
    "addxp/removexp/setxp/setlevel/resetlevel/resetdaily/lookup/top/reload/save/status/help/exit"
  );

  setStatusLine(
    "LEVEL",
    "Totals",
    "xpEvents=0, levelUps=0, commands=0, users=0, failedSaves=0"
  );

  setStatusLine("LEVEL", "Last XP", "None yet");
  setStatusLine("LEVEL", "Last Level Up", "None yet");
  setStatusLine("LEVEL", "Last Command", "None yet");
  setStatusLine("LEVEL", "Error", "None");
}

function updateTotalsLine() {
  setStatusLine(
    "LEVEL",
    "Totals",
    `xpEvents=${xpEventsThisRun}, ` +
      `levelUps=${levelUpsThisRun}, ` +
      `commands=${commandsHandledThisRun}, ` +
      `users=${Object.keys(levels).length}, ` +
      `failedSaves=${failedSavesThisRun}`
  );
}

// -----------------------------------------------------------------------------
// Files
// -----------------------------------------------------------------------------

function ensureDataFiles() {
  if (!fs.existsSync(DATA_DIRECTORY)) {
    fs.mkdirSync(DATA_DIRECTORY, {
      recursive: true,
    });
  }

  if (!fs.existsSync(LEVELS_PATH)) {
    fs.writeFileSync(LEVELS_PATH, "{}\n", "utf8");
  }

  if (!fs.existsSync(ADMIN_COMMANDS_PATH)) {
    fs.writeFileSync(ADMIN_COMMANDS_PATH, "", "utf8");
  }

  if (!fs.existsSync(XP_BOOST_PATH)) {
    fs.writeFileSync(
      XP_BOOST_PATH,
      `${JSON.stringify(
        {
          multiplier: 1,
          startedAt: 0,
          endsAt: 0,
          startedBy: null,
        },
        null,
        2
      )}\n`,
      "utf8"
    );
  }
}

function loadLevels() {
  try {
    const raw = fs.readFileSync(LEVELS_PATH, "utf8").trim();

    if (!raw) {
      return {};
    }

    const loaded = JSON.parse(raw);

    if (
      typeof loaded !== "object" ||
      loaded === null ||
      Array.isArray(loaded)
    ) {
      throw new Error("lvls.json must contain a JSON object");
    }

    return loaded;
  } catch (error) {
    setStatusLine(
      "LEVEL",
      "Error",
      `Failed to load lvls.json: ${formatError(error)}`
    );

    setStatusLine(
      "LEVEL",
      "Fix",
      "Fix data/lvls.json or replace its contents with {}"
    );

    process.exit(1);
  }
}

function repairLoadedLevelData() {
  let repaired = false;

  for (const user of Object.values(levels)) {
    if (!user || typeof user !== "object") {
      continue;
    }

    const safeXp = Math.max(
      0,
      Number.isFinite(Number(user.xp))
        ? Math.floor(Number(user.xp))
        : 0
    );

    const calculatedLevel = calculateLevel(safeXp);

    if (user.xp !== safeXp) {
      user.xp = safeXp;
      repaired = true;
    }

    if (user.level !== calculatedLevel) {
      user.level = calculatedLevel;
      repaired = true;
    }

    if (!Number.isFinite(Number(user.messages))) {
      user.messages = 0;
      repaired = true;
    }

    if (!Number.isFinite(Number(user.lastXpAt))) {
      user.lastXpAt = 0;
      repaired = true;
    }

    if (!Number.isFinite(Number(user.lastDailyAt))) {
      user.lastDailyAt = 0;
      repaired = true;
    }
  }

  if (repaired) {
    saveLevels();
  }
}

function saveLevels() {
  try {
    const temporaryPath = `${LEVELS_PATH}.tmp`;

    fs.writeFileSync(
      temporaryPath,
      `${JSON.stringify(levels, null, 2)}\n`,
      "utf8"
    );

    fs.renameSync(temporaryPath, LEVELS_PATH);

    return true;
  } catch (error) {
    failedSavesThisRun += 1;
    updateTotalsLine();

    setStatusLine(
      "LEVEL",
      "Error",
      `Failed to save lvls.json: ${formatError(error)}`
    );

    return false;
  }
}

// -----------------------------------------------------------------------------
// Temporary XP boost storage and helpers
// -----------------------------------------------------------------------------

function createInactiveXpBoost() {
  return {
    multiplier: 1,
    startedAt: 0,
    endsAt: 0,
    startedBy: null,
  };
}

function loadXpBoost() {
  try {
    const raw = fs
      .readFileSync(XP_BOOST_PATH, "utf8")
      .trim();

    if (!raw) {
      return createInactiveXpBoost();
    }

    const loaded = JSON.parse(raw);
    const multiplier = Number(loaded.multiplier);
    const startedAt = Number(loaded.startedAt);
    const endsAt = Number(loaded.endsAt);

    return {
      multiplier:
        Number.isFinite(multiplier) &&
        multiplier >= MIN_XP_BOOST_MULTIPLIER &&
        multiplier <= MAX_XP_BOOST_MULTIPLIER
          ? multiplier
          : 1,
      startedAt:
        Number.isFinite(startedAt) && startedAt > 0
          ? startedAt
          : 0,
      endsAt:
        Number.isFinite(endsAt) && endsAt > 0
          ? endsAt
          : 0,
      startedBy:
        loaded.startedBy
          ? String(loaded.startedBy)
          : null,
    };
  } catch (error) {
    setStatusLine(
      "LEVEL",
      "Error",
      `Failed to load XP boost: ${formatError(error)}`
    );

    return createInactiveXpBoost();
  }
}

function saveXpBoost() {
  try {
    const temporaryPath = `${XP_BOOST_PATH}.tmp`;

    fs.writeFileSync(
      temporaryPath,
      `${JSON.stringify(xpBoost, null, 2)}\n`,
      "utf8"
    );

    fs.renameSync(temporaryPath, XP_BOOST_PATH);
    return true;
  } catch (error) {
    setStatusLine(
      "LEVEL",
      "Error",
      `Failed to save XP boost: ${formatError(error)}`
    );

    return false;
  }
}

function isXpBoostActive() {
  return Boolean(
    Number(xpBoost.multiplier) > 1 &&
    Number(xpBoost.endsAt) > Date.now()
  );
}

function clearExpiredXpBoost() {
  if (
    Number(xpBoost.endsAt) > 0 &&
    Number(xpBoost.endsAt) <= Date.now()
  ) {
    xpBoost = createInactiveXpBoost();
    saveXpBoost();
  }
}

function getActiveXpMultiplier() {
  clearExpiredXpBoost();

  if (!isXpBoostActive()) {
    return 1;
  }

  return Number(xpBoost.multiplier);
}

function updateXpBoostStatusLine() {
  clearExpiredXpBoost();

  if (!isXpBoostActive()) {
    setStatusLine(
      "LEVEL",
      "XP Boost",
      "Inactive"
    );
    return;
  }

  const remainingMs = xpBoost.endsAt - Date.now();

  setStatusLine(
    "LEVEL",
    "XP Boost",
    `${formatMultiplier(xpBoost.multiplier)}x active — ` +
      `${formatRemainingTime(remainingMs)} remaining — ` +
      `started by ${xpBoost.startedBy || "unknown"}`
  );
}

function startXpBoost(multiplier, durationMs, startedBy) {
  xpBoost = {
    multiplier,
    startedAt: Date.now(),
    endsAt: Date.now() + durationMs,
    startedBy: startedBy || "unknown",
  };

  saveXpBoost();
  updateXpBoostStatusLine();
  return xpBoost;
}

function stopXpBoost() {
  const wasActive = isXpBoostActive();

  xpBoost = createInactiveXpBoost();

  saveXpBoost();
  updateXpBoostStatusLine();

  return wasActive;
}

function buildXpBoostStatusText() {
  clearExpiredXpBoost();

  if (!isXpBoostActive()) {
    return "There is no active XP boost.";
  }

  const remainingMs = xpBoost.endsAt - Date.now();

  return (
    `${formatMultiplier(xpBoost.multiplier)}x XP is active for another ` +
    `${formatRemainingTime(remainingMs)}.`
  );
}

// -----------------------------------------------------------------------------
// Level calculations
// -----------------------------------------------------------------------------

function randomInt(minimum, maximum) {
  return (
    Math.floor(Math.random() * (maximum - minimum + 1)) +
    minimum
  );
}

function xpRequiredForLevel(level) {
  if (level <= 1) {
    return 0;
  }

  return Math.floor(
    100 * Math.pow(level - 1, 1.5)
  );
}

function calculateLevel(totalXp) {
  const safeXp = Math.max(
    0,
    Math.floor(Number(totalXp) || 0)
  );

  let level = 1;

  while (xpRequiredForLevel(level + 1) <= safeXp) {
    level += 1;
  }

  return level;
}

function xpToNextLevel(totalXp) {
  const safeXp = Math.max(
    0,
    Math.floor(Number(totalXp) || 0)
  );

  const currentLevel = calculateLevel(safeXp);
  const nextLevelXp = xpRequiredForLevel(currentLevel + 1);

  return Math.max(0, nextLevelXp - safeXp);
}

// -----------------------------------------------------------------------------
// User helpers
// -----------------------------------------------------------------------------

function getOrCreateUser(userId, username, displayName) {
  if (!userId) {
    return null;
  }

  const now = new Date().toISOString();

  if (!levels[userId]) {
    levels[userId] = {
      username: username || "unknown",
      displayName: displayName || username || "unknown",
      xp: 0,
      level: 1,
      messages: 0,
      lastXpAt: 0,
      lastDailyAt: 0,
      createdAt: now,
      updatedAt: now,
    };
  }

  const user = levels[userId];

  user.username =
    username ||
    user.username ||
    "unknown";

  user.displayName =
    displayName ||
    user.displayName ||
    username ||
    "unknown";

  return user;
}

function findUserByName(name) {
  if (!name) {
    return null;
  }

  const cleanName = cleanUsername(name);

  for (const [userId, data] of Object.entries(levels)) {
    const username = cleanUsername(data.username);
    const displayName = cleanUsername(data.displayName);

    if (
      username === cleanName ||
      displayName === cleanName
    ) {
      return {
        userId,
        data,
      };
    }
  }

  return null;
}

function cleanUsername(name) {
  return String(name || "")
    .trim()
    .replace(/^@/, "")
    .toLowerCase();
}

function getSortedUsers() {
  return Object.entries(levels).sort((first, second) => {
    const firstXp = Number(first[1]?.xp) || 0;
    const secondXp = Number(second[1]?.xp) || 0;

    return secondXp - firstXp;
  });
}

function isModOrBroadcaster(tags) {
  return Boolean(
    tags.badges?.broadcaster === "1" ||
      tags.badges?.moderator === "1" ||
      tags.mod === true
  );
}

function isKnownBot(username) {
  return BOT_USERNAMES.has(
    cleanUsername(username)
  );
}

// -----------------------------------------------------------------------------
// XP earning
// -----------------------------------------------------------------------------

function isEligibleForXp({
  username,
  message,
  self,
}) {
  if (self) {
    return {
      eligible: false,
      reason: "self message",
    };
  }

  if (isKnownBot(username)) {
    return {
      eligible: false,
      reason: "known bot",
    };
  }

  const trimmed = String(message || "").trim();

  if (trimmed.startsWith("!")) {
    return {
      eligible: false,
      reason: "command",
    };
  }

  if (trimmed.length < MIN_MESSAGE_LENGTH) {
    return {
      eligible: false,
      reason: "too short",
    };
  }

  return {
    eligible: true,
  };
}

function awardXpIfAllowed(
  userId,
  username,
  displayName
) {
  const user = getOrCreateUser(
    userId,
    username,
    displayName
  );

  if (!user) {
    return;
  }

  const now = Date.now();

  const timeSinceLastXp =
    now - (Number(user.lastXpAt) || 0);

  if (timeSinceLastXp < XP_COOLDOWN_MS) {
    return;
  }

  const oldLevel = calculateLevel(user.xp || 0);

  const baseXp = randomInt(
    MIN_XP_PER_MESSAGE,
    MAX_XP_PER_MESSAGE
  );

  const activeMultiplier =
    getActiveXpMultiplier();

  const xpGained = Math.max(
    1,
    Math.floor(
      baseXp * activeMultiplier
    )
  );

  updateXpBoostStatusLine();

  user.xp = Math.max(
    0,
    (Number(user.xp) || 0) + xpGained
  );

  user.messages =
    (Number(user.messages) || 0) + 1;

  user.lastXpAt = now;
  user.updatedAt = new Date().toISOString();
  user.level = calculateLevel(user.xp);

  xpEventsThisRun += 1;
  updateTotalsLine();

  saveLevels();

  const remaining = xpToNextLevel(user.xp);

  const multiplierText =
    activeMultiplier > 1
      ? ` [${formatMultiplier(activeMultiplier)}x boost]`
      : "";

  setStatusLine(
    "LEVEL",
    "Last XP",
    `${displayName} +${xpGained} XP${multiplierText} -> ` +
      `Lv${user.level} (${remaining} XP to next)`
  );

  if (user.level > oldLevel) {
    registerLevelUp(
      user,
      `chat XP`
    );

    if (ANNOUNCE_LEVEL_UPS) {
      client
        .say(
          TWITCH_CHANNEL,
          `🎉 @${displayName} leveled up to Level ${user.level}!`
        )
        .catch((error) => {
          setStatusLine(
            "LEVEL",
            "Error",
            `Failed to announce level-up: ${formatError(error)}`
          );
        });
    }
  }
}

function registerLevelUp(user, source) {
  levelUpsThisRun += 1;
  updateTotalsLine();

  setStatusLine(
    "LEVEL",
    "Last Level Up",
    `${user.displayName || user.username} reached ` +
      `Lv${user.level} via ${source}`
  );
}

// -----------------------------------------------------------------------------
// Twitch events
// -----------------------------------------------------------------------------

function setupLevelEvents() {
  client.on("connected", () => {
    setStatusLine("LEVEL", "Status", "Running");

    setStatusLine(
      "LEVEL",
      "Connection",
      `Connected to #${TWITCH_CHANNEL} as ${BOT_USERNAME}`
    );

    setStatusLine("LEVEL", "Token", "Ready");
    setStatusLine("LEVEL", "Error", "None");
  });

  client.on(
    "disconnected",
    (reason) => {
      if (!shuttingDown) {
        setStatusLine(
          "LEVEL",
          "Connection",
          `Disconnected: ${reason || "unknown reason"}`
        );
      }
    }
  );

  client.on(
    "message",
    safeAsync("LEVEL", "Chat handler failed", async (channel, tags, message, self) => {
      if (self || shuttingDown || alreadySeenMessage(tags.id)) return;
      const username =
        tags.username || "unknown";

      const displayName =
        tags["display-name"] || username;

      const userId = tags["user-id"];

      if (String(message).trim().startsWith("!")) {
        await handleChatCommand(tags, message);
        return;
      }

      const eligibility = isEligibleForXp({
        username,
        message,
        self,
      });

      if (!eligibility.eligible) {
        return;
      }

      awardXpIfAllowed(
        userId,
        username,
        displayName
      );
    })
  );

  client.on("error", (error) => {
    setStatusLine(
      "LEVEL",
      "Error",
      `Twitch client error: ${formatError(error)}`
    );
  });
}

// -----------------------------------------------------------------------------
// Chat commands
// -----------------------------------------------------------------------------

async function handleChatCommand(tags, message) {
  const username =
    tags.username || "unknown";

  const displayName =
    tags["display-name"] || username;

  const parts = String(message)
    .trim()
    .split(/\s+/);

  const command = parts[0].toLowerCase();
  const args = parts.slice(1);

  const publicCommands = new Set([
    "!level",
    "!lvl",
    "!xp",
    "!rank",
    "!topyappers",
    "!daily",
    "!booststatus",
  ]);

  const modCommands = new Set([
    "!addxp",
    "!removexp",
    "!remxp",
    "!setxp",
    "!setlevel",
    "!setlvl",
    "!resetlevel",
    "!resetlvl",
    "!resetdaily",
    "!boost",
    "!xpboost",
    "!stopboost",
    "!endboost",
  ]);

  if (
    !publicCommands.has(command) &&
    !modCommands.has(command)
  ) {
    return;
  }

  commandsHandledThisRun += 1;
  updateTotalsLine();

  setStatusLine(
    "LEVEL",
    "Last Command",
    `${displayName}: ${message}`
  );

  if (
    modCommands.has(command) &&
    !isModOrBroadcaster(tags)
  ) {
    await client.say(
      TWITCH_CHANNEL,
      `@${displayName} you need to be a mod to use that.`
    );

    return;
  }

  if (
    command === "!level" ||
    command === "!lvl" ||
    command === "!xp"
  ) {
    await sendLevelResponse(tags, args);
    return;
  }

  if (command === "!rank") {
    await sendRankResponse(tags, args);
    return;
  }

  if (command === "!topyappers") {
    await sendLeaderboardResponse();
    return;
  }

  if (command === "!daily") {
    await handleDailyCommand(tags, args);
    return;
  }

  if (command === "!booststatus") {
    await client.say(
      TWITCH_CHANNEL,
      buildXpBoostStatusText()
    );
    return;
  }

  if (
    command === "!boost" ||
    command === "!xpboost"
  ) {
    const result = handleStartBoostCommand(
      args,
      displayName
    );

    await client.say(
      TWITCH_CHANNEL,
      result.message
    );
    return;
  }

  if (
    command === "!stopboost" ||
    command === "!endboost"
  ) {
    const result = handleStopBoostCommand(
      displayName
    );

    await client.say(
      TWITCH_CHANNEL,
      result.message
    );
    return;
  }

  const localCommand = command.slice(1);

  const result = await executeAdminCommand(
    localCommand,
    args,
    {
      source: "chat",
      actor: displayName,
    }
  );

  await client.say(
    TWITCH_CHANNEL,
    result.message
  );
}

async function sendLevelResponse(tags, args) {
  const requesterDisplayName =
    tags["display-name"] ||
    tags.username ||
    "unknown";

  const requesterUserId = tags["user-id"];
  const requesterUsername =
    tags.username || "unknown";

  let targetEntry;

  if (args[0]) {
    targetEntry = findUserByName(args[0]);
  } else {
    const user = getOrCreateUser(
      requesterUserId,
      requesterUsername,
      requesterDisplayName
    );

    targetEntry = {
      userId: requesterUserId,
      data: user,
    };
  }

  if (!targetEntry?.data) {
    await client.say(
      TWITCH_CHANNEL,
      `@${requesterDisplayName} I don't have level data for that user yet.`
    );

    return;
  }

  const user = targetEntry.data;
  const level = calculateLevel(user.xp || 0);
  const remaining = xpToNextLevel(user.xp || 0);

  await client.say(
    TWITCH_CHANNEL,
    `@${user.displayName || user.username} is ` +
      `Level ${level} with ${user.xp || 0} XP. ` +
      `${remaining} XP to next level.`
  );
}

async function sendRankResponse(tags, args) {
  const requesterDisplayName =
    tags["display-name"] ||
    tags.username ||
    "unknown";

  const requesterUserId = tags["user-id"];
  const requesterUsername =
    tags.username || "unknown";

  let targetEntry;

  if (args[0]) {
    targetEntry = findUserByName(args[0]);
  } else {
    const user = getOrCreateUser(
      requesterUserId,
      requesterUsername,
      requesterDisplayName
    );

    targetEntry = {
      userId: requesterUserId,
      data: user,
    };
  }

  if (!targetEntry?.data) {
    await client.say(
      TWITCH_CHANNEL,
      `@${requesterDisplayName} I don't have rank data for that user yet.`
    );

    return;
  }

  const sorted = getSortedUsers();

  const rankIndex = sorted.findIndex(
    ([userId]) => userId === targetEntry.userId
  );

  if (rankIndex === -1) {
    await client.say(
      TWITCH_CHANNEL,
      `@${requesterDisplayName} I don't have rank data for that user yet.`
    );

    return;
  }

  const user = targetEntry.data;

  await client.say(
    TWITCH_CHANNEL,
    `@${user.displayName || user.username} is ` +
      `rank #${rankIndex + 1} with ${user.xp || 0} XP, ` +
      `Level ${calculateLevel(user.xp || 0)}.`
  );
}

async function sendLeaderboardResponse() {
  const message = buildLeaderboardText();

  await client.say(
    TWITCH_CHANNEL,
    message
  );
}

async function handleDailyCommand(tags) {
  const userId = tags["user-id"];
  const username = tags.username || "unknown";
  const displayName =
    tags["display-name"] || username;

  const user = getOrCreateUser(
    userId,
    username,
    displayName
  );

  if (!user) {
    await client.say(
      TWITCH_CHANNEL,
      `@${displayName} I couldn't find your Twitch user ID.`
    );

    return;
  }

  const now = Date.now();
  const lastDailyAt =
    Number(user.lastDailyAt) || 0;

  const nextDailyAt =
    lastDailyAt + DAILY_COOLDOWN_MS;

  if (lastDailyAt > 0 && now < nextDailyAt) {
    const remainingMs = nextDailyAt - now;

    await client.say(
      TWITCH_CHANNEL,
      `@${displayName} you already claimed your daily reward. ` +
        `Try again in ${formatRemainingTime(remainingMs)}.`
    );

    return;
  }

  const oldLevel = calculateLevel(
    user.xp || 0
  );

  const baseDailyXp = randomInt(
    DAILY_MIN_XP,
    DAILY_MAX_XP
  );

  const dailyMultiplier =
    XP_BOOST_APPLIES_TO_DAILY
      ? getActiveXpMultiplier()
      : 1;

  const dailyXp = Math.max(
    1,
    Math.floor(
      baseDailyXp * dailyMultiplier
    )
  );

  user.xp =
    (Number(user.xp) || 0) + dailyXp;

  user.level = calculateLevel(user.xp);
  user.lastDailyAt = now;
  user.updatedAt = new Date().toISOString();

  saveLevels();
  updateTotalsLine();

  const didLevelUp = user.level > oldLevel;

  if (didLevelUp) {
    registerLevelUp(
      user,
      "daily reward"
    );
  }

  let response =
    `@${displayName} claimed their daily reward: ` +
    `+${dailyXp} XP! They are now Level ${user.level} ` +
    `with ${user.xp} XP.`;

  if (didLevelUp) {
    response += ` 🎉 Level up!`;
  }

  await client.say(
    TWITCH_CHANNEL,
    response
  );
}

function buildLeaderboardText() {
  const sorted = getSortedUsers().slice(
    0,
    TOP_LIMIT
  );

  if (sorted.length === 0) {
    return "No level data yet.";
  }

  const text = sorted
    .map(([, user], index) => {
      const displayName =
        user.displayName ||
        user.username ||
        "unknown";

      return (
        `#${index + 1} ${displayName}: ` +
        `Lv${calculateLevel(user.xp || 0)} ` +
        `(${user.xp || 0} XP)`
      );
    })
    .join(" | ");

  return `Top Yappers: ${text}`;
}

// -----------------------------------------------------------------------------
// Terminal command input
// -----------------------------------------------------------------------------

function setupTerminalCommands() {
  if (terminalCommandsStarted) {
    return;
  }

  terminalCommandsStarted = true;

  // systemd usually provides no interactive terminal.
  // In that case the text-file command system still works.
  if (!process.stdin.isTTY) {
    setStatusLine(
      "LEVEL",
      "Terminal",
      "No interactive terminal; admin file control enabled"
    );

    return;
  }

  const readlineInterface =
    readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

  readlineInterface.on(
    "line",
    async (input) => {
      const result =
        await processLocalCommandLine(
          input,
          "terminal"
        );

      if (result?.message) {
        setStatusLine(
          "LEVEL",
          "Terminal",
          result.message
        );
      }
    }
  );
}

// -----------------------------------------------------------------------------
// Text-file command queue
// -----------------------------------------------------------------------------

function setupAdminCommandFile() {
  setInterval(
    pollAdminCommandFile,
    ADMIN_COMMAND_POLL_MS
  );

  setStatusLine(
    "LEVEL",
    "Admin File",
    `Watching ${ADMIN_COMMANDS_PATH}`
  );
}

async function pollAdminCommandFile() {
  if (
    adminCommandPollInProgress ||
    shuttingDown
  ) {
    return;
  }

  adminCommandPollInProgress = true;

  try {
    if (!fs.existsSync(ADMIN_COMMANDS_PATH)) {
      fs.writeFileSync(
        ADMIN_COMMANDS_PATH,
        "",
        "utf8"
      );

      return;
    }

    const contents = fs.readFileSync(
      ADMIN_COMMANDS_PATH,
      "utf8"
    );

    if (!contents.trim()) {
      return;
    }

    /*
     * Clear the file before executing commands.
     *
     * This means the same command should not execute repeatedly
     * if one of the command handlers crashes.
     */
    fs.writeFileSync(
      ADMIN_COMMANDS_PATH,
      "",
      "utf8"
    );

    const commandLines = contents
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !line.startsWith("#"));

    for (const commandLine of commandLines) {
      const result =
        await processLocalCommandLine(
          commandLine,
          "admin-file"
        );

      setStatusLine(
        "LEVEL",
        "Last Command",
        `[admin-file] ${commandLine}`
      );

      if (result?.message) {
        setStatusLine(
          "LEVEL",
          "Admin File",
          result.message
        );
      }

      if (result?.shouldExit) {
        break;
      }
    }
  } catch (error) {
    setStatusLine(
      "LEVEL",
      "Error",
      `Admin file command failed: ${formatError(error)}`
    );
  } finally {
    adminCommandPollInProgress = false;
  }
}

// -----------------------------------------------------------------------------
// Shared local/admin command parser
// -----------------------------------------------------------------------------

async function processLocalCommandLine(
  input,
  source
) {
  const raw = String(input || "").trim();

  if (!raw) {
    return {
      success: false,
      message: "No command supplied.",
    };
  }

  // Allows either:
  // addxp username 100
  // !addxp username 100
  const cleaned = raw.startsWith("!")
    ? raw.slice(1)
    : raw;

  const parts = cleaned.split(/\s+/);
  const command = parts[0].toLowerCase();
  const args = parts.slice(1);

  commandsHandledThisRun += 1;
  updateTotalsLine();

  setStatusLine(
    "LEVEL",
    "Last Command",
    `[${source}] ${raw}`
  );

  return executeAdminCommand(
    command,
    args,
    {
      source,
      actor: source,
    }
  );
}

// -----------------------------------------------------------------------------
// Shared admin commands
// -----------------------------------------------------------------------------

async function executeAdminCommand(
  command,
  args,
  context
) {
  switch (command) {
    case "addxp":
      return addXpToUser(args, context);

    case "removexp":
    case "remxp":
      return removeXpFromUser(args);

    case "setxp":
      return setUserXp(args);

    case "setlevel":
    case "setlvl":
      return setUserLevel(args);

    case "resetlevel":
    case "resetlvl":
      return resetUserLevel(args);

    case "resetdaily":
      return resetUserDaily(args);

    case "lookup":
    case "user":
      return lookupUser(args);

    case "top":
      return {
        success: true,
        message: buildLeaderboardText(),
      };

    case "reload":
      levels = loadLevels();
      repairLoadedLevelData();
      updateTotalsLine();

      return {
        success: true,
        message: "Reloaded lvls.json from disk.",
      };

    case "save":
      if (saveLevels()) {
        return {
          success: true,
          message: "Saved lvls.json.",
        };
      }

      return {
        success: false,
        message: "Failed to save lvls.json.",
      };

    case "boost":
    case "xpboost":
      return handleStartBoostCommand(
        args,
        context.actor
      );

    case "stopboost":
    case "endboost":
      return handleStopBoostCommand(
        context.actor
      );

    case "booststatus":
      return {
        success: true,
        message: buildXpBoostStatusText(),
      };

    case "status":
      return {
        success: true,
        message:
          `Running. Users=${Object.keys(levels).length}, ` +
          `XP events=${xpEventsThisRun}, ` +
          `level-ups=${levelUpsThisRun}, ` +
          `commands=${commandsHandledThisRun}, ` +
          `failed saves=${failedSavesThisRun}.`,
      };

    case "help":
    case "commands":
      return {
        success: true,
        message:
          "Commands: addxp username amount | " +
          "removexp username amount | " +
          "setxp username amount | " +
          "setlevel username level | " +
          "resetlevel username | " +
          "resetdaily username | " +
          "lookup username | top | reload | save | " +
          "boost multiplier duration | stopboost | booststatus | " +
          "status | help | exit",
      };

    case "exit":
    case "quit":
      /*
       * Exit is deliberately allowed from the admin file.
       * When managed by systemd with Restart=always, systemd may
       * automatically start the bot again.
       */
      await shutdownLevelBot(context.source);

      return {
        success: true,
        shouldExit: true,
        message: "Bot shut down.",
      };

    default:
      return {
        success: false,
        message: `Unknown command: ${command}`,
      };
  }
}

// -----------------------------------------------------------------------------
// Admin command implementations
// -----------------------------------------------------------------------------

function addXpToUser(args, context) {
  const targetName = args[0];
  const amount = parsePositiveInteger(args[1]);

  if (!targetName || amount === null) {
    return {
      success: false,
      message: "Usage: addxp username amount",
    };
  }

  const target = findUserByName(targetName);

  if (!target) {
    return {
      success: false,
      message:
        `No data for ${targetName}. ` +
        "They need to chat once first.",
    };
  }

  const oldLevel = calculateLevel(
    target.data.xp || 0
  );

  target.data.xp = Math.max(
    0,
    (Number(target.data.xp) || 0) + amount
  );

  target.data.level = calculateLevel(
    target.data.xp
  );

  target.data.updatedAt =
    new Date().toISOString();

  saveLevels();
  updateTotalsLine();

  if (target.data.level > oldLevel) {
    registerLevelUp(
      target.data,
      context.source
    );
  }

  return {
    success: true,
    message:
      `Added ${amount} XP to ` +
      `${target.data.displayName}. ` +
      `Lv${target.data.level}, ` +
      `${target.data.xp} XP.`,
  };
}

function removeXpFromUser(args) {
  const targetName = args[0];
  const amount = parsePositiveInteger(args[1]);

  if (!targetName || amount === null) {
    return {
      success: false,
      message: "Usage: removexp username amount",
    };
  }

  const target = findUserByName(targetName);

  if (!target) {
    return {
      success: false,
      message: `No data for ${targetName}.`,
    };
  }

  target.data.xp = Math.max(
    0,
    (Number(target.data.xp) || 0) - amount
  );

  target.data.level = calculateLevel(
    target.data.xp
  );

  target.data.updatedAt =
    new Date().toISOString();

  saveLevels();
  updateTotalsLine();

  return {
    success: true,
    message:
      `Removed ${amount} XP from ` +
      `${target.data.displayName}. ` +
      `Lv${target.data.level}, ` +
      `${target.data.xp} XP.`,
  };
}

function setUserXp(args) {
  const targetName = args[0];
  const amount = parseNonNegativeInteger(
    args[1]
  );

  if (!targetName || amount === null) {
    return {
      success: false,
      message: "Usage: setxp username amount",
    };
  }

  const target = findUserByName(targetName);

  if (!target) {
    return {
      success: false,
      message: `No data for ${targetName}.`,
    };
  }

  const oldLevel = calculateLevel(
    target.data.xp || 0
  );

  target.data.xp = amount;
  target.data.level = calculateLevel(amount);
  target.data.updatedAt =
    new Date().toISOString();

  saveLevels();
  updateTotalsLine();

  if (target.data.level > oldLevel) {
    registerLevelUp(
      target.data,
      "setxp"
    );
  }

  return {
    success: true,
    message:
      `Set ${target.data.displayName} to ` +
      `Lv${target.data.level}, ` +
      `${target.data.xp} XP.`,
  };
}

function setUserLevel(args) {
  const targetName = args[0];
  const level = parsePositiveInteger(args[1]);

  if (!targetName || level === null) {
    return {
      success: false,
      message: "Usage: setlevel username level",
    };
  }

  const target = findUserByName(targetName);

  if (!target) {
    return {
      success: false,
      message: `No data for ${targetName}.`,
    };
  }

  const oldLevel = calculateLevel(
    target.data.xp || 0
  );

  const requiredXp =
    xpRequiredForLevel(level);

  target.data.xp = requiredXp;
  target.data.level = level;
  target.data.updatedAt =
    new Date().toISOString();

  saveLevels();
  updateTotalsLine();

  if (level > oldLevel) {
    registerLevelUp(
      target.data,
      "setlevel"
    );
  }

  return {
    success: true,
    message:
      `Set ${target.data.displayName} to ` +
      `Lv${level}, ${requiredXp} XP.`,
  };
}

function resetUserLevel(args) {
  const targetName = args[0];

  if (!targetName) {
    return {
      success: false,
      message: "Usage: resetlevel username",
    };
  }

  const target = findUserByName(targetName);

  if (!target) {
    return {
      success: false,
      message: `No data for ${targetName}.`,
    };
  }

  target.data.xp = 0;
  target.data.level = 1;
  target.data.messages = 0;
  target.data.lastXpAt = 0;
  target.data.updatedAt =
    new Date().toISOString();

  saveLevels();
  updateTotalsLine();

  return {
    success: true,
    message:
      `Reset ${target.data.displayName} to Lv1.`,
  };
}

function lookupUser(args) {
  const targetName = args[0];

  if (!targetName) {
    return {
      success: false,
      message: "Usage: lookup username",
    };
  }

  const target = findUserByName(targetName);

  if (!target) {
    return {
      success: false,
      message: `No data for ${targetName}.`,
    };
  }

  const user = target.data;
  const level = calculateLevel(user.xp || 0);
  const remaining = xpToNextLevel(
    user.xp || 0
  );

  const sorted = getSortedUsers();

  const rank =
    sorted.findIndex(
      ([userId]) => userId === target.userId
    ) + 1;

  return {
    success: true,
    message:
      `${user.displayName || user.username}: ` +
      `rank #${rank}, ` +
      `Lv${level}, ` +
      `${user.xp || 0} XP, ` +
      `${remaining} XP to next.`,
  };
}

function resetUserDaily(args) {
  const targetName = args[0];

  if (!targetName) {
    return {
      success: false,
      message: "Usage: resetdaily username",
    };
  }

  const target = findUserByName(targetName);

  if (!target) {
    return {
      success: false,
      message: `No data for ${targetName}.`,
    };
  }

  target.data.lastDailyAt = 0;
  target.data.updatedAt =
    new Date().toISOString();

  saveLevels();

  return {
    success: true,
    message:
      `Reset the daily reward cooldown for ` +
      `${target.data.displayName}.`,
  };
}

// -----------------------------------------------------------------------------
// XP boost commands
// -----------------------------------------------------------------------------

function handleStartBoostCommand(args, startedBy) {
  const multiplier = parseBoostMultiplier(args[0]);
  const durationMs = parseDuration(args[1]);

  if (multiplier === null) {
    return {
      success: false,
      message:
        `Usage: boost multiplier duration. Example: boost 5 10m. ` +
        `Multiplier must be between ${MIN_XP_BOOST_MULTIPLIER} and ` +
        `${MAX_XP_BOOST_MULTIPLIER}.`,
    };
  }

  if (durationMs === null) {
    return {
      success: false,
      message:
        "Invalid duration. Examples: 30s, 10m, 1h, 2d.",
    };
  }

  if (durationMs > MAX_XP_BOOST_DURATION_MS) {
    return {
      success: false,
      message:
        "The maximum boost duration is 30 days.",
    };
  }

  startXpBoost(
    multiplier,
    durationMs,
    startedBy
  );

  return {
    success: true,
    message:
      `${formatMultiplier(multiplier)}x XP boost started for ` +
      `${formatRemainingTime(durationMs)}!`,
  };
}

function handleStopBoostCommand(stoppedBy) {
  const wasActive = stopXpBoost();

  if (!wasActive) {
    return {
      success: false,
      message:
        "There was no active XP boost.",
    };
  }

  return {
    success: true,
    message:
      `The XP boost was stopped by ${stoppedBy || "an admin"}.`,
  };
}

function parseBoostMultiplier(value) {
  const multiplier = Number(value);

  if (
    !Number.isFinite(multiplier) ||
    multiplier < MIN_XP_BOOST_MULTIPLIER ||
    multiplier > MAX_XP_BOOST_MULTIPLIER
  ) {
    return null;
  }

  return Math.round(multiplier * 100) / 100;
}

function parseDuration(value) {
  const match = String(value || "")
    .trim()
    .toLowerCase()
    .match(/^(\d+(?:\.\d+)?)(s|m|h|d)$/);

  if (!match) {
    return null;
  }

  const amount = Number(match[1]);
  const unit = match[2];

  if (
    !Number.isFinite(amount) ||
    amount <= 0
  ) {
    return null;
  }

  const unitMilliseconds = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };

  const durationMs = Math.floor(
    amount * unitMilliseconds[unit]
  );

  if (durationMs < 1000) {
    return null;
  }

  return durationMs;
}

function formatMultiplier(value) {
  const multiplier = Number(value);

  if (Number.isInteger(multiplier)) {
    return String(multiplier);
  }

  return multiplier
    .toFixed(2)
    .replace(/0+$/, "")
    .replace(/\.$/, "");
}

// -----------------------------------------------------------------------------
// Parsing helpers
// -----------------------------------------------------------------------------

function parsePositiveInteger(value) {
  const number = Number(value);

  if (
    !Number.isFinite(number) ||
    number <= 0
  ) {
    return null;
  }

  return Math.floor(number);
}

function parseNonNegativeInteger(value) {
  const number = Number(value);

  if (
    !Number.isFinite(number) ||
    number < 0
  ) {
    return null;
  }

  return Math.floor(number);
}

function formatError(error) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function formatRemainingTime(milliseconds) {
  const totalMinutes = Math.max(
    1,
    Math.ceil(milliseconds / 60000)
  );

  const days = Math.floor(
    totalMinutes / 1440
  );

  const hours = Math.floor(
    (totalMinutes % 1440) / 60
  );

  const minutes = totalMinutes % 60;

  const parts = [];

  if (days > 0) {
    parts.push(`${days}d`);
  }

  if (hours > 0) {
    parts.push(`${hours}h`);
  }

  if (minutes > 0 || parts.length === 0) {
    parts.push(`${minutes}m`);
  }

  return parts.join(" ");
}


// -----------------------------------------------------------------------------
// Shutdown
// -----------------------------------------------------------------------------

async function shutdownLevelBot(source) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  runtime?.stop();
  setTimeout(() => process.exit(0), 5_000).unref();

  setStatusLine(
    "LEVEL",
    "Status",
    `Saving and shutting down via ${source}...`
  );

  saveLevels();
  saveXpBoost();

  try {
    if (client) {
      await client.disconnect();
    }
  } catch (error) {
    setStatusLine(
      "LEVEL",
      "Error",
      `Failed to disconnect cleanly: ${formatError(error)}`
    );
  }

  process.exit(0);
}

process.on("SIGINT", async () => {
  await shutdownLevelBot("SIGINT");
});

process.on("SIGTERM", async () => {
  await shutdownLevelBot("SIGTERM");
});

function fatalLevelBot(error) {
  if (shuttingDown) return;
  shuttingDown = true;
  runtime?.stop();
  setStatusLine("LEVEL", "Fatal", formatError(error));
  try {
    if (levelDataLoaded) saveLevels();
    if (xpBoostDataLoaded) saveXpBoost();
  } finally {
    process.exit(1);
  }
}

process.on("uncaughtException", fatalLevelBot);
process.on("unhandledRejection", fatalLevelBot);
