// joinBot.js

require("dotenv").config({
  path: require("path").join(__dirname, ".env"),
  quiet: true,
});

const {
  requireSingleInstance,
  createChatClient,
  safeAsync,
  startBotRuntime,
} = require("./utils/botRuntime");
const { createMessageDeduper } = require("./utils/messageDeduper");
const readline = require("readline");

const { ensureValidToken } = require("./tokenManager");
const { setStatusLine } = require("./utils/logger");
const { isStreamLive } = require("./utils/twitchApi");

const {
  TWITCH_CHANNEL,

  // personal join account
  JOIN_USERNAME,
  JOIN_ACCESS_TOKEN,

  // bot account, hosts raffles and optionally joins Tangia
  BOT_USERNAME,

  CLIENT_ID,
  BROADCASTER_ID,
} = process.env;

if (
  !TWITCH_CHANNEL ||
  !JOIN_USERNAME ||
  !JOIN_ACCESS_TOKEN ||
  !BOT_USERNAME ||
  !process.env.ACCESS_TOKEN ||
  !CLIENT_ID ||
  !BROADCASTER_ID
) {
  console.error("Missing required values in .env");
  console.error("Required:");
  console.error("TWITCH_CHANNEL");
  console.error("JOIN_USERNAME");
  console.error("JOIN_ACCESS_TOKEN");
  console.error("BOT_USERNAME");
  console.error("ACCESS_TOKEN");
  console.error("CLIENT_ID");
  console.error("BROADCASTER_ID");
  process.exit(1);
}

requireSingleInstance("joinbot", TWITCH_CHANNEL);
const alreadySeenMessage = createMessageDeduper();

// Raffle settings.
// bot starts the raffle.
// profile optionally joins the raffle if aj is ON.
const raffleCommand = "!raffle 100000 60";
const raffleJoinCommand = "!join";

// First raffle happens 10 minutes after enabling auto raffle.
// After that, raffle runs every 30 minutes.
const raffleIntervalMs = 30 * 60 * 1000;
const raffleStartDelayMs = 10 * 60 * 1000;

// Raffle join delay is randomised to look less robotic.
// Only itsnotrynox uses this for raffle joins.
const raffleJoinMinDelayMs = 10 * 1000;
const raffleJoinMaxDelayMs = 58 * 1000;

// Tangia triggers.
// If any chat message contains one of these phrases, Tangia auto-join runs
// after 5 seconds. Keep these lowercase because incoming messages are
// converted to lowercase before checking.
const tangiaTriggers = [
  "started a tangia dungeon",
  "started a tangia boss fight",
];

// Tangia joins should always happen after 5 seconds.
const tangiaJoinDelayMs = 5 * 1000;

// Twitch chat command settings.
// Terminal commands stay as: ar on, aj off, rt status
// Twitch chat commands use prefix: ~ar on, ~aj off, ~rt status
const chatCommandPrefix = "~";

const approvedChatCommands = new Set([
  "ar on",
  "ar off",
  "ar status",

  "aj on",
  "aj off",
  "aj status",

  "rt on",
  "rt off",
  "rt status",

  "refresh",
]);

// Who is allowed to control the bot from Twitch chat.
// Default allowed users:
// - channel owner
// - personal account
// - bot account
//
// Optional .env:
// ADMIN_USERS=someuser,anotheruser
const adminUsers = [
  TWITCH_CHANNEL,
  JOIN_USERNAME,
  BOT_USERNAME,
  ...(process.env.ADMIN_USERS || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean),
].map((x) => x.toLowerCase());

// Runtime auto-join toggle.
// This only affects personal account joining auto raffles.
// Tangia joins ignore this toggle.
let autoJoinEnabled = false;

// Runtime auto-raffle toggle.
// bot will only host raffles when this is ON.
let autoRaffleEnabled = false;

// Runtime bot Tangia auto-join toggle.
// personal account always joins Tangia.
// This controls whether bot also joins Tangia.
let botTangiaJoinEnabled = true;
let autoRaffleStartTimeout = null;
let autoRaffleInterval = null;
let runtime;
let shuttingDown = false;
let raffleRunInProgress = false;
let raffleGeneration = 0;
let raffleJoinTimeout = null;
const tangiaTimeouts = new Map();

// Twitch clients.
let botClient; // bot account hosts raffles, optionally joins Tangia
let joinClient; // personal account joins raffles, always joins Tangia

// Listener client.
// We only listen from one client so one Tangia message does not get detected twice.
let listenerClient;

// Prevents terminal command listener from being started more than once.
let terminalCommandsStarted = false;

// Prevents duplicate message listeners during reconnects.
let joinEventsSetup = false;

// Live dashboard counters.
let tangiaDetectedThisRun = 0;
let tangiaJoinsThisRun = 0;
let rafflesStartedThisRun = 0;
let raffleJoinsThisRun = 0;
let failedJoinsThisRun = 0;

async function startJoinBot() {
  initialiseDashboard("Starting join bot...");

  try {
    setStatusLine("JOINER", "Token", "Checking personal account token...");
    await ensureValidToken("join");

    setStatusLine("JOINER", "Token", "Checking bot token...");
    await ensureValidToken("bot");

    setStatusLine("JOINER", "Token", "Tokens ready");
  } catch (error) {
    setStatusLine(
      "JOINER",
      "Error",
      `Token check failed: ${error.message || error}`
    );
    setStatusLine(
      "JOINER",
      "Fix",
      "Try: node auth.js join and node auth.js bot"
    );
    process.exit(1);
  }

  createClients();
  runtime = startBotRuntime({
    prefix: "JOINER",
    connections: [
      {
        client: joinClient,
        channel: TWITCH_CHANNEL,
        profile: "join",
      },
      {
        client: botClient,
        channel: TWITCH_CHANNEL,
        profile: "bot",
      },
    ],
    onFatal: fatalJoinBot,
  });

  setupJoinEvents();
  setupTerminalCommands();

  try {
    setStatusLine(
      "JOINER",
      "Connection",
      `Connecting ${JOIN_USERNAME} + ${BOT_USERNAME} to #${TWITCH_CHANNEL}...`
    );

    await joinClient.connect();
    setStatusLine("JOINER", "Connection", `Connected ${JOIN_USERNAME}`);

    await botClient.connect();
    setStatusLine(
      "JOINER",
      "Connection",
      `Connected ${JOIN_USERNAME} + ${BOT_USERNAME}`
    );

    setStatusLine(
      "JOINER",
      "Token Refresh",
      "Token check every 4 minutes; connections stay in place"
    );

    setStatusLine("JOINER", "Status", "Running");
    setStatusLine("JOINER", "Error", "None");
  } catch (error) {
    setStatusLine(
      "JOINER",
      "Error",
      `Failed to connect to Twitch chat: ${error.message || error}`
    );
    process.exit(1);
  }
}

startJoinBot().catch(fatalJoinBot);

function createClients() {
  if (joinClient || botClient) {
    throw new Error("Join clients must only be created once");
  }

  joinClient = createChatClient({
    username: JOIN_USERNAME,
    channel: TWITCH_CHANNEL,
    profile: "join",
  });

  botClient = createChatClient({
    username: BOT_USERNAME,
    channel: TWITCH_CHANNEL,
    profile: "bot",
  });

  // Listen using profile account. This avoids both accounts detecting the same
  // Tangia message and double-scheduling.
  listenerClient = joinClient;

  // Attach one set of application listeners to these clients.
  joinEventsSetup = false;

  setStatusLine(
    "JOINER",
    "Accounts",
    `Raffle host=${BOT_USERNAME}, raffle joiner=${JOIN_USERNAME}, ` +
      `Tangia=${JOIN_USERNAME}+${BOT_USERNAME}`
  );
}

function initialiseDashboard(statusMessage) {
  setStatusLine("JOINER", "Status", statusMessage);
  setStatusLine("JOINER", "Connection", "Not connected yet");
  setStatusLine("JOINER", "Accounts", "Waiting");
  setStatusLine("JOINER", "Token", "Waiting");
  setStatusLine("JOINER", "Token Refresh", "Waiting");
  setStatusLine(
    "JOINER",
    "Auto Raffle",
    "OFF by default. Type ar on or ~ar on to enable."
  );
  setStatusLine(
    "JOINER",
    "Auto Join",
    `OFF by default. Type aj on or ~aj on to let ${JOIN_USERNAME} join raffles.`
  );
  setStatusLine(
    "JOINER",
    "Tangia",
    `${JOIN_USERNAME} always joins. ${BOT_USERNAME}=ON by default. ` +
      "Use rt on/off/status or ~rt on/off/status."
  );
  setStatusLine("JOINER", "Trigger", tangiaTriggers.join(" | "));
  setStatusLine("JOINER", "Last Detection", "None yet");
  setStatusLine("JOINER", "Last Scheduled", "None yet");
  setStatusLine("JOINER", "Last Join", "None yet");
  setStatusLine(
    "JOINER",
    "Totals",
    "tangiaDetected=0, tangiaJoins=0, rafflesStarted=0, " +
      "raffleJoins=0, failed=0"
  );
  setStatusLine(
    "JOINER",
    "Commands",
    "terminal: ar/aj/rt/refresh/exit | chat: ~ar/~aj/~rt/~refresh"
  );
  setStatusLine("JOINER", "Error", "None");
}

function updateTotalsLine() {
  setStatusLine(
    "JOINER",
    "Totals",
    `tangiaDetected=${tangiaDetectedThisRun}, ` +
      `tangiaJoins=${tangiaJoinsThisRun}, ` +
      `rafflesStarted=${rafflesStartedThisRun}, ` +
      `raffleJoins=${raffleJoinsThisRun}, ` +
      `failed=${failedJoinsThisRun}`
  );
}

function getRandomRaffleJoinDelayMs() {
  return (
    Math.floor(
      Math.random() * (raffleJoinMaxDelayMs - raffleJoinMinDelayMs + 1)
    ) + raffleJoinMinDelayMs
  );
}

function isChatAdmin(tags) {
  const username = (tags.username || "").toLowerCase();
  return adminUsers.includes(username);
}

function normaliseChatCommand(message) {
  const trimmed = message.trim();

  if (!trimmed.startsWith(chatCommandPrefix)) {
    return null;
  }

  const command = trimmed.slice(chatCommandPrefix.length).trim().toLowerCase();

  if (!approvedChatCommands.has(command)) {
    return null;
  }

  return command;
}

async function disconnectClientsCleanly(reason) {
  setStatusLine("JOINER", "Status", reason || "Disconnecting...");

  try {
    if (joinClient && joinClient.readyState() === "OPEN") {
      await joinClient.disconnect();
    }
  } catch (_) {
    // Ignore disconnect errors. Client may already be disconnected.
  }

  try {
    if (botClient && botClient.readyState() === "OPEN") {
      await botClient.disconnect();
    }
  } catch (_) {
    // Ignore disconnect errors. Client may already be disconnected.
  }
}

async function checkCurrentTokens() {
  await runtime.checkTokens();
}

// Sends a message from one account/client.
async function sayFromClient(client, username, message, reason) {
  try {
    await client.say(TWITCH_CHANNEL, message);

    return {
      username,
      ok: true,
    };
  } catch (error) {
    failedJoinsThisRun += 1;
    updateTotalsLine();

    return {
      username,
      ok: false,
      error: error.message || String(error),
      reason,
    };
  }
}

async function replyToChat(message) {
  try {
    if (!botClient) {
      return;
    }

    await botClient.say(TWITCH_CHANNEL, message);
  } catch (error) {
    setStatusLine(
      "JOINER",
      "Error",
      `[CHAT REPLY] Failed to reply in chat: ${error.message || error}`
    );
  }
}

// Sends !join for Tangia.
// personal account always joins.
// bot account only joins if botTangiaJoinEnabled is ON.
async function tangiaJoinFromAccounts(reason) {
  const results = [];

  // Personal account always joins Tangia.
  results.push(
    await sayFromClient(joinClient, JOIN_USERNAME, raffleJoinCommand, reason)
  );

  // bot Tangia joining is toggleable.
  if (botTangiaJoinEnabled) {
    results.push(
      await sayFromClient(botClient, BOT_USERNAME, raffleJoinCommand, reason)
    );
  }

  const successNames = results.filter((x) => x.ok).map((x) => x.username);
  const failedNames = results.filter((x) => !x.ok).map((x) => x.username);

  if (failedNames.length > 0) {
    setStatusLine(
      "JOINER",
      "Error",
      `[TANGIA] Failed from ${failedNames.join(", ")}`
    );
  } else {
    setStatusLine("JOINER", "Error", "None");
  }

  tangiaJoinsThisRun += successNames.length;
  updateTotalsLine();

  const skippedText = botTangiaJoinEnabled
    ? ""
    : ` | ${BOT_USERNAME} skipped`;

  setStatusLine(
    "JOINER",
    "Last Join",
    `[TANGIA] Sent ${raffleJoinCommand} from ${
      successNames.join(", ") || "none"
    }${skippedText}`
  );
}

// Schedules itsnotrynox to join a raffle.
// rynoxbot does NOT join raffles here. rynoxbot only hosts the raffle.
function scheduleRaffleJoin(reason) {
  if (!autoJoinEnabled) {
    setStatusLine(
      "JOINER",
      "Last Scheduled",
      `Skipped ${raffleJoinCommand}. Auto join is OFF. Reason: ${reason}`
    );
    return;
  }

  const joinDelayMs = getRandomRaffleJoinDelayMs();
  const joinDelaySeconds = Math.round(joinDelayMs / 1000);

  setStatusLine(
    "JOINER",
    "Last Scheduled",
    `[RAFFLE] ${JOIN_USERNAME} will send ${raffleJoinCommand} in ` +
      `${joinDelaySeconds}s`
  );

  if (raffleJoinTimeout) {
    clearTimeout(raffleJoinTimeout);
  }

  const generation = raffleGeneration;

  raffleJoinTimeout = setTimeout(
    safeAsync("JOINER", "Raffle join failed", async () => {
      raffleJoinTimeout = null;

      if (
        shuttingDown ||
        !autoRaffleEnabled ||
        generation !== raffleGeneration ||
        !autoJoinEnabled
      ) {
        setStatusLine(
          "JOINER",
          "Last Join",
          `Cancelled ${raffleJoinCommand}. Auto join was turned OFF. ` +
            `Reason: ${reason}`
        );
        return;
      }

      const result = await sayFromClient(
        joinClient,
        JOIN_USERNAME,
        raffleJoinCommand,
        reason
      );

      if (result.ok) {
        raffleJoinsThisRun += 1;
        setStatusLine(
          "JOINER",
          "Last Join",
          `[RAFFLE] ${JOIN_USERNAME} sent ${raffleJoinCommand}`
        );
        setStatusLine("JOINER", "Error", "None");
      } else {
        setStatusLine(
          "JOINER",
          "Error",
          `[RAFFLE] ${JOIN_USERNAME} failed to send ${raffleJoinCommand}: ` +
            result.error
        );
      }

      updateTotalsLine();
    }),
    joinDelayMs
  );
}

// Schedules Tangia join after 5 seconds.
// itsnotrynox always joins.
// rynoxbot joins only if rt is ON.
function scheduleTangiaJoin(reason) {
  if (shuttingDown || tangiaTimeouts.has(reason)) {
    return;
  }

  const joinDelaySeconds = Math.round(tangiaJoinDelayMs / 1000);
  const tangiaAccounts = botTangiaJoinEnabled
    ? `${JOIN_USERNAME}+${BOT_USERNAME}`
    : `${JOIN_USERNAME} only`;

  setStatusLine(
    "JOINER",
    "Last Scheduled",
    `[TANGIA] ${tangiaAccounts} scheduled in ${joinDelaySeconds}s`
  );

  const timer = setTimeout(
    safeAsync("JOINER", "Tangia join failed", async () => {
      try {
        if (!shuttingDown) {
          await tangiaJoinFromAccounts(reason);
        }
      } finally {
        tangiaTimeouts.delete(reason);
      }
    }),
    tangiaJoinDelayMs
  );

  tangiaTimeouts.set(reason, timer);
}

// Starts the auto raffle system.
// rynoxbot hosts the raffle.
function startAutoRaffleSystem() {
  if (autoRaffleEnabled) {
    setStatusLine("JOINER", "Auto Raffle", "Already ON");
    return;
  }

  autoRaffleEnabled = true;
  raffleGeneration += 1;

  setStatusLine(
    "JOINER",
    "Auto Raffle",
    `ON. ${BOT_USERNAME} hosts first raffle in ${Math.round(
      raffleStartDelayMs / 60000
    )} minutes, then every ${Math.round(raffleIntervalMs / 60000)} minutes.`
  );

  autoRaffleStartTimeout = setTimeout(() => {
    autoRaffleStartTimeout = null;
    if (!autoRaffleEnabled || shuttingDown) {
      return;
    }

    runAutoRaffle();

    autoRaffleInterval = setInterval(() => {
      if (!autoRaffleEnabled) {
        return;
      }
      runAutoRaffle();
    }, raffleIntervalMs);
  }, raffleStartDelayMs);
}

function stopAutoRaffleSystem() {
  autoRaffleEnabled = false;
  raffleGeneration += 1;

  if (autoRaffleStartTimeout) {
    clearTimeout(autoRaffleStartTimeout);
  }

  if (autoRaffleInterval) {
    clearInterval(autoRaffleInterval);
  }

  if (raffleJoinTimeout) {
    clearTimeout(raffleJoinTimeout);
  }

  autoRaffleStartTimeout = null;
  autoRaffleInterval = null;
  raffleJoinTimeout = null;

  setStatusLine("JOINER", "Auto Raffle", "OFF");
}

async function handleBotCommand(command, source = "terminal") {
  if (command === "ar on") {
    startAutoRaffleSystem();
    return `Auto raffle is ON. First raffle in ${Math.round(
      raffleStartDelayMs / 60000
    )} mins, then every ${Math.round(raffleIntervalMs / 60000)} mins.`;
  }

  if (command === "ar off") {
    stopAutoRaffleSystem();
    return "Auto raffle is OFF.";
  }

  if (command === "ar status") {
    return `Auto raffle is currently ${autoRaffleEnabled ? "ON" : "OFF"}. Host=${BOT_USERNAME}.`;
  }

  if (command === "aj on") {
    autoJoinEnabled = true;
    setStatusLine(
      "JOINER",
      "Auto Join",
      `ON. ${JOIN_USERNAME} joins auto raffles`
    );
    return `Auto join is ON. ${JOIN_USERNAME} will join auto raffles.`;
  }

  if (command === "aj off") {
    autoJoinEnabled = false;
    if (raffleJoinTimeout) {
      clearTimeout(raffleJoinTimeout);
    }

    raffleJoinTimeout = null;
    setStatusLine(
      "JOINER",
      "Auto Join",
      `OFF for raffles. Tangia still joins from ${JOIN_USERNAME}${
        botTangiaJoinEnabled ? `+${BOT_USERNAME}` : ""
      }`
    );
    return `Auto join is OFF for raffles. Tangia still joins from ${JOIN_USERNAME}${
      botTangiaJoinEnabled ? ` + ${BOT_USERNAME}` : ""
    }.`;
  }

  if (command === "aj status") {
    return `Auto join is currently ${
      autoJoinEnabled ? "ON" : "OFF"
    } for ${JOIN_USERNAME} raffle joins. Tangia is always ON for ${JOIN_USERNAME}${
      botTangiaJoinEnabled ? ` + ${BOT_USERNAME}` : ""
    }.`;
  }

  if (command === "rt on") {
    botTangiaJoinEnabled = true;
    setStatusLine(
      "JOINER",
      "Tangia",
      `${JOIN_USERNAME} always joins. ${BOT_USERNAME}=ON for Tangia.`
    );
    return `${BOT_USERNAME} Tangia auto-join is ON.`;
  }

  if (command === "rt off") {
    botTangiaJoinEnabled = false;
    setStatusLine(
      "JOINER",
      "Tangia",
      `${JOIN_USERNAME} always joins. ${BOT_USERNAME}=OFF for Tangia.`
    );
    return (
      `${BOT_USERNAME} Tangia auto-join is OFF. ` +
      `${JOIN_USERNAME} still always joins.`
    );
  }

  if (command === "rt status") {
    return `${JOIN_USERNAME} always joins Tangia. ${BOT_USERNAME} Tangia auto-join is currently ${
      botTangiaJoinEnabled ? "ON" : "OFF"
    }.`;
  }

  if (command === "refresh") {
    await checkCurrentTokens();
    return (
      "Token check completed. Chat connections are maintained automatically."
    );
  }

  if (command === "exit" || command === "quit") {
    if (source !== "terminal") {
      setStatusLine(
        "JOINER",
        "Commands",
        "Exit/quit is terminal-only for safety."
      );
      return "Exit/quit is terminal-only for safety.";
    }

    await shutdownJoinBot();
  }

  return null;
}

function setupTerminalCommands() {
  if (terminalCommandsStarted || !process.stdin.isTTY) {
    return;
  }
  terminalCommandsStarted = true;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  rl.on(
    "line",
    safeAsync("JOINER", "Terminal command failed", async (input) => {
      const command = input.trim().toLowerCase();
      const response = await handleBotCommand(command, "terminal");

      if (response) {
        setStatusLine("JOINER", "Commands", response);
      } else {
        setStatusLine("JOINER", "Commands", `Unknown command: ${input}`);
      }
    })
  );
}

function setupJoinEvents() {
  if (joinEventsSetup) {
    return;
  }

  joinEventsSetup = true;

  // Only one client listens to chat. This avoids double Tangia detection.
  listenerClient.on("connected", () => {
    setStatusLine("JOINER", "Status", "Running");
    setStatusLine("JOINER", "Token", "Ready");
    setStatusLine("JOINER", "Error", "None");
  });

  listenerClient.on("disconnected", (reason) => {
    setStatusLine(
      "JOINER",
      "Connection",
      `Disconnected: ${reason || "unknown reason"}`
    );
  });

  listenerClient.on(
    "message",
    safeAsync(
      "JOINER",
      "Chat handler failed",
      async (channel, tags, message, self) => {
        if (shuttingDown || alreadySeenMessage(tags.id)) {
          return;
        }

        const user = tags["display-name"] || tags.username || "unknown";
        const lowerMessage = message.toLowerCase();

        // Approved chat commands only. Anything else, including normal
        // !commands, is ignored.
        const chatCommand = normaliseChatCommand(message);

        if (chatCommand) {
          if (!isChatAdmin(tags)) {
            setStatusLine(
              "JOINER",
              "Commands",
              `Ignored approved command from non-admin ${user}: ${message}`
            );
            return;
          }

          const response = await handleBotCommand(chatCommand, `chat:${user}`);

          if (response) {
            setStatusLine(
              "JOINER",
              "Commands",
              `Chat command from ${user}: ${message}`
            );
            await replyToChat(response);
          }

          return;
        }

        // Ignore our own normal chat messages for detection purposes.
        if (self) {
          return;
        }

        const matchedTangiaTrigger = tangiaTriggers.find((trigger) =>
          lowerMessage.includes(trigger)
        );

        if (matchedTangiaTrigger) {
          tangiaDetectedThisRun += 1;
          updateTotalsLine();

          const reason = matchedTangiaTrigger.includes("boss")
            ? "Tangia Boss Fight detected"
            : "Tangia Dungeon detected";

          setStatusLine(
            "JOINER",
            "Last Detection",
            `[TANGIA] ${reason} from ${user}`
          );
          scheduleTangiaJoin(reason);
        }
      }
    )
  );
}

// Runs the automatic raffle flow.
// 1. Checks bot token.
// 2. Checks if stream is live.
// 3. bot sends !raffle.
// 4. If auto raffle join is enabled, personal account sends !join after random delay.
// If stream is offline, auto raffle turns OFF but the bot stays running.
async function runAutoRaffle() {
  if (!autoRaffleEnabled || shuttingDown || raffleRunInProgress) {
    return;
  }

  const generation = raffleGeneration;
  const stillEnabled = () =>
    autoRaffleEnabled &&
    !shuttingDown &&
    generation === raffleGeneration;

  raffleRunInProgress = true;

  try {
    await ensureValidToken("bot");

    if (!stillEnabled()) {
      return;
    }

    const live = await isStreamLive({
      broadcasterId: BROADCASTER_ID,
      tokenProfile: "bot",
      clientId: CLIENT_ID,
    });

    // ar off can arrive while a network request is awaiting a response.
    if (!stillEnabled()) {
      return;
    }

    if (!live) {
      stopAutoRaffleSystem();
      setStatusLine(
        "JOINER",
        "Auto Raffle",
        "OFF because stream is offline. Use ar on or ~ar on next stream."
      );
      return;
    }

    await botClient.say(TWITCH_CHANNEL, raffleCommand);
    rafflesStartedThisRun += 1;
    updateTotalsLine();

    setStatusLine(
      "JOINER",
      "Last Join",
      `[RAFFLE] ${BOT_USERNAME} sent ${raffleCommand}`
    );

    if (stillEnabled()) {
      scheduleRaffleJoin("Auto raffle");
    }

    setStatusLine("JOINER", "Error", "None");
  } catch (error) {
    // A timeout is not proof that a chat message was not sent. Never blindly
    // retry the same raffle; wait for the next scheduled slot.
    setStatusLine(
      "JOINER",
      "Error",
      `[RAFFLE] ${error?.message || error}; skipping this slot`
    );
  } finally {
    raffleRunInProgress = false;
  }
}

function stopJoinWork() {
  runtime?.stop();
  stopAutoRaffleSystem();
  for (const timer of tangiaTimeouts.values()) {
    clearTimeout(timer);
  }
  tangiaTimeouts.clear();
}

function fatalJoinBot(error) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  stopJoinWork();
  setStatusLine("JOINER", "Fatal", error?.message || String(error));
  process.exit(1);
}

async function shutdownJoinBot() {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  stopJoinWork();
  setTimeout(() => process.exit(0), 5_000).unref();
  await disconnectClientsCleanly("Shutting down...");
  process.exit(0);
}

process.on("SIGINT", shutdownJoinBot);
process.on("SIGTERM", shutdownJoinBot);
process.on("uncaughtException", fatalJoinBot);
process.on("unhandledRejection", fatalJoinBot);
