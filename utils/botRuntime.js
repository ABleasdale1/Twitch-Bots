const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const tmi = require("tmi.js");

const { tryFileLock } = require("./fileLock");
const { ensureValidToken } = require("../tokenManager");
const { setStatusLine } = require("./logger");

function requireSingleInstance(botName, channel) {
  const uid =
    typeof process.getuid === "function"
      ? process.getuid()
      : os.userInfo().username;

  const directory = path.join(os.tmpdir(), `twitch-bots-${uid}`);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });

  const key = crypto
    .createHash("sha256")
    .update(`${botName}:${String(channel).replace(/^#/, "").toLowerCase()}`)
    .digest("hex")
    .slice(0, 24);

  const lock = tryFileLock(path.join(directory, `${key}.lock`));

  if (!lock) {
    console.error(
      `[${botName}] Another copy is already running for this channel. ` +
        "Stop the extra manual/service copy. Exit code 73."
    );
    process.exit(73);
  }

  // A normal exit closes this explicitly; the kernel also closes it on SIGKILL.
  process.once("exit", () => lock.release());
}

function createChatClient({ username, channel, profile }) {
  return new tmi.Client({
    options: {
      debug: false,
      skipUpdatingEmotesets: true,
    },
    connection: {
      secure: true,
      reconnect: true,
      maxReconnectAttempts: Infinity,
      reconnectDecay: 1.5,
      reconnectInterval: 2_000,
      maxReconnectInterval: 60_000,
    },
    identity: {
      username,

      // tmi.js calls this for every login, including its own reconnects.
      password: async () =>
        `oauth:${(await ensureValidToken(profile)).accessToken}`,
    },
    channels: [channel],
  });
}

function safeAsync(prefix, label, handler) {
  return (...args) =>
    Promise.resolve()
      .then(() => handler(...args))
      .catch((error) => {
        setStatusLine(prefix, "Error", `${label}: ${error?.message || error}`);
      });
}

// One long-lived tmi client per account. tmi owns normal reconnects; if it
// becomes stuck (including authentication failures disabling reconnect),
// exit so systemd can start a completely fresh process.
function startBotRuntime({
  prefix,
  connections,
  onFatal,
  healthTimeoutMs = 180_000,
  healthCheckMs = 15_000,
  tokenCheckMs = 4 * 60_000,
  now = Date.now,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  ensureToken = ensureValidToken,
}) {
  let stopped = false;
  let maintenance = null;

  const normalise = (channel) =>
    String(channel).replace(/^#/, "").toLowerCase();

  const states = connections.map(({ client, channel, profile }) => ({
    client,
    channel: normalise(channel),
    profile,
    connected: false,
    joined: false,
    lastPong: now(),
    unhealthySince: now(),
  }));

  const listeners = [];

  function listen(client, event, handler) {
    client.on(event, handler);
    listeners.push([client, event, handler]);
  }

  function fail(reason) {
    if (stopped) {
      return;
    }

    stop();
    setStatusLine(prefix, "Recovery", reason);
    onFatal(reason);
  }

  for (const state of states) {
    listen(state.client, "connected", () => {
      state.connected = true;
      state.joined = false;
      state.lastPong = now();
    });

    const joined = (channel) => {
      if (normalise(channel) === state.channel && state.connected) {
        state.joined = true;
        state.unhealthySince = null;
      }
    };

    listen(state.client, "roomstate", joined);
    listen(state.client, "join", (channel, username, self) => {
      if (self) {
        joined(channel);
      }
    });
    listen(state.client, "pong", () => {
      state.lastPong = now();
    });
    listen(state.client, "disconnected", (reason) => {
      state.connected = false;
      state.joined = false;

      if (state.unhealthySince === null) {
        state.unhealthySince = now();
      }

      setStatusLine(
        prefix,
        `Connection ${state.profile}`,
        `Disconnected: ${reason || "unknown"}; waiting for reconnect`
      );
    });
    listen(state.client, "part", (channel, username, self) => {
      if (self && normalise(channel) === state.channel) {
        state.joined = false;

        if (state.unhealthySince === null) {
          state.unhealthySince = now();
        }
      }
    });
    listen(state.client, "error", (error) => {
      setStatusLine(
        prefix,
        "Error",
        `Chat ${state.profile}: ${error?.message || error}`
      );
    });
  }

  const healthTimer = setIntervalFn(() => {
    for (const state of states) {
      if (
        state.connected &&
        state.joined &&
        state.client.readyState() === "OPEN"
      ) {
        if (now() - state.lastPong >= healthTimeoutMs) {
          fail(
            `No Twitch heartbeat for ${Math.round(healthTimeoutMs / 1000)}s ` +
              `(${state.profile}); restarting bot`
          );
          return;
        }

        state.unhealthySince = null;
      } else {
        if (state.unhealthySince === null) {
          state.unhealthySince = now();
        }

        if (now() - state.unhealthySince >= healthTimeoutMs) {
          fail(
            `Chat unavailable for ${Math.round(healthTimeoutMs / 1000)}s ` +
              `(${state.profile}); restarting bot`
          );
          return;
        }
      }
    }
  }, healthCheckMs);

  function checkTokens() {
    if (stopped) {
      return Promise.resolve();
    }

    if (maintenance) {
      return maintenance;
    }

    maintenance = (async () => {
      for (const profile of new Set(states.map((state) => state.profile))) {
        const result = await ensureToken(profile);

        if (stopped) {
          return;
        }

        setStatusLine(
          prefix,
          `Token ${profile}`,
          result.temporaryFailure
            ? "Temporary validation failure; retrying on next check"
            : "Token ready (checked every 4 minutes)"
        );
      }
    })()
      .catch((error) => {
        // Fatal token errors must close existing sessions too. Restarting retries
        // transient refresh failures; revoked grants still need authorisation.
        fail(
          `Token maintenance failed: ${error?.message || error}; restarting bot`
        );
      })
      .finally(() => {
        maintenance = null;
      });

    return maintenance;
  }

  const tokenTimer = setIntervalFn(checkTokens, tokenCheckMs);

  function stop() {
    if (stopped) {
      return;
    }

    stopped = true;
    clearIntervalFn(healthTimer);
    clearIntervalFn(tokenTimer);

    for (const [client, event, handler] of listeners) {
      client.removeListener(event, handler);
    }
  }

  return {
    stop,
    checkTokens,
  };
}

module.exports = {
  requireSingleInstance,
  createChatClient,
  safeAsync,
  startBotRuntime,
};
