// utils/logger.js

const readline = require("readline");

// Stores dashboard/status lines.
// Each key updates the same terminal line instead of printing forever.
const statusLines = new Map();

// Returns local system time in UK-style 24-hour format for logs.
function getSysTime() {
  return new Date().toLocaleString("en-GB", {
    hour12: false,
  });
}

// Old-style normal log.
// Still available for other bots if you want scrolling logs there.
function logWithTime(prefix, message) {
  console.log(`[${getSysTime()}] [${prefix}] ${message}`);
}

// Old-style error log.
// Still available for other bots if needed.
function errorWithTime(prefix, message) {
  console.error(`[${getSysTime()}] [${prefix}] ${message}`);
}

// Updates a fixed dashboard line.
// Same prefix + key = same line gets replaced next time.
function setStatusLine(prefix, key, message) {
  const id = `${prefix}:${key}`;

  // Services have no TTY. Write only the changed row, never the entire
  // dashboard on every XP event (which multiplied journal/SD-card writes).
  if (!process.stdout.isTTY && statusLines.get(id)?.message === message) return;

  statusLines.set(id, {
    time: getSysTime(),
    prefix,
    key,
    message,
  });

  if (!process.stdout.isTTY) {
    const line = statusLines.get(id);
    console.log(`[${line.time}] [${line.prefix}] ${line.key}: ${line.message}`);
  } else {
    renderStatusDashboard();
  }
}

// Clears the terminal and redraws all known status lines.
function renderStatusDashboard() {
  // If stdout is not an interactive terminal, fall back to regular logging.
  if (!process.stdout.isTTY) {
    for (const line of statusLines.values()) {
      console.log(`[${line.time}] [${line.prefix}] ${line.key}: ${line.message}`);
    }
    return;
  }

  readline.cursorTo(process.stdout, 0, 0);
  readline.clearScreenDown(process.stdout);

  console.log("=== Twitch Bot Live Status ===");
  console.log("");

  for (const line of statusLines.values()) {
    console.log(`[${line.time}] [${line.prefix}] ${line.key}: ${line.message}`);
  }
}

module.exports = {
  getSysTime,
  logWithTime,
  errorWithTime,
  setStatusLine,
};
