const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { createRequire } = require("module");
const { EventEmitter } = require("events");
const root = path.resolve(__dirname, "..");

function loadModule(relative, mocks = {}, globals = {}) {
  const filename = path.join(root, relative);
  const nativeRequire = createRequire(filename);
  const context = {
    module: { exports: {} }, exports: {}, __dirname: path.dirname(filename), __filename: filename,
    require: (name) => Object.hasOwn(mocks, name) ? mocks[name] : nativeRequire(name),
    console: { log() {}, warn() {}, error() {} },
    process, Buffer, URL, URLSearchParams, AbortSignal, Response,
    setTimeout, clearTimeout, setInterval, clearInterval,
    ...globals,
  };
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), context, { filename });
  return context.module.exports;
}

function fakeTimers() {
  let id = 0;
  const jobs = new Map();
  return {
    jobs,
    setTimeout: (fn, ms) => { const key = ++id; jobs.set(key, { fn, ms, interval: false }); return key; },
    clearTimeout: (key) => jobs.delete(key),
    setInterval: (fn, ms) => { const key = ++id; jobs.set(key, { fn, ms, interval: true }); return key; },
    clearInterval: (key) => jobs.delete(key),
    async fire(key) {
      const job = jobs.get(key);
      if (!job) return;
      if (!job.interval) jobs.delete(key);
      await job.fn();
    },
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function joinHarness() {
  const timers = fakeTimers();
  const clients = [];
  const failures = [];
  const exits = [];
  let liveCheck = async () => true;
  let tokenChecks = 0;
  const context = {
    __dirname: root,
    console: { log() {}, error() {} },
    process: {
      env: { TWITCH_CHANNEL: "testchannel", BOT_USERNAME: "testbot", JOIN_USERNAME: "testjoin",
        ACCESS_TOKEN: "fake", JOIN_ACCESS_TOKEN: "fake", CLIENT_ID: "fake", BROADCASTER_ID: "fake" },
      stdin: { isTTY: false }, stdout: { isTTY: false }, on() {},
      exit(code) { exits.push(code); },
    },
    ...timers,
    require(name) {
      if (name === "dotenv") return { config() {} };
      if (name === "./tokenManager") return { ensureValidToken: async () => ({ accessToken: "fake" }) };
      if (name === "./utils/logger") return { setStatusLine() {} };
      if (name === "./utils/twitchApi") return { isStreamLive: (...args) => liveCheck(...args) };
      if (name === "./utils/botRuntime") return {
        requireSingleInstance() {},
        safeAsync: (prefix, label, handler) => (...args) => Promise.resolve().then(() => handler(...args)).catch((e) => failures.push(e)),
        startBotRuntime: () => ({ stop() {}, checkTokens: async () => { tokenChecks += 1; } }),
        createChatClient({ username }) {
          const client = new EventEmitter();
          client.username = username;
          client.sent = [];
          client.connectCount = 0;
          client.connect = async () => { client.connectCount += 1; client.emit("connected"); };
          client.readyState = () => "OPEN";
          client.disconnect = async () => {};
          client.say = async (channel, message) => { client.sent.push(message); };
          clients.push(client);
          return client;
        },
      };
      return createRequire(path.join(root, "joinBot.js"))(name);
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, "joinBot.js"), "utf8") + `
    globalThis.testing = { command: handleBotCommand, run: runAutoRaffle,
      get enabled() { return autoRaffleEnabled; } };
  `, context, { filename: "joinBot.js" });
  await flush();
  return {
    ...context.testing, state: context.testing, timers, clients, failures, exits,
    get tokenChecks() { return tokenChecks; },
    setLiveCheck(fn) { liveCheck = fn; },
    async message(id, text, username = "testchannel") {
      const client = clients.find((client) => client.username === "testjoin");
      for (const handler of client.listeners("message")) {
        await handler("#testchannel", { id, username }, text, false);
      }
    },
    get host() { return clients.find((client) => client.username === "testbot"); },
    get joiner() { return clients.find((client) => client.username === "testjoin"); },
  };
}

module.exports = { root, loadModule, fakeTimers, deferred, flush, joinHarness };
