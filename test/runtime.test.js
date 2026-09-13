const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter, once } = require("events");
const { spawn, spawnSync } = require("child_process");
const path = require("path");
const { WebSocketServer } = require("ws");
const { root, loadModule, fakeTimers, deferred, flush } = require("./helpers");

function healthHarness(ensureToken = async () => ({})) {
  const timers = fakeTimers();
  let now = 0;
  const failures = [];
  const { startBotRuntime } = loadModule("utils/botRuntime.js", { "./logger": { setStatusLine() {} } });
  const client = new EventEmitter();
  client.readyState = () => "OPEN";
  const runtime = startBotRuntime({ prefix: "TEST", connections: [{ client, channel: "channel", profile: "bot" }],
    onFatal: (reason) => failures.push(reason), now: () => now,
    setIntervalFn: timers.setInterval, clearIntervalFn: timers.clearInterval, ensureToken });
  const healthJob = [...timers.jobs].find(([, job]) => job.ms === 15_000)[0];
  return { runtime, client, timers, failures, setNow(value) { now = value; },
    check: () => timers.fire(healthJob),
    connect() { client.emit("connected"); client.emit("roomstate", "#channel"); } };
}

test("quiet chat remains healthy when Twitch heartbeats arrive", async () => {
  const h = healthHarness();
  h.connect();
  for (let now = 60_000; now < 1_000_000; now += 60_000) {
    h.setNow(now); h.client.emit("pong"); await h.check();
  }
  assert.equal(h.failures.length, 0);
  h.runtime.stop();
  assert.equal(h.timers.jobs.size, 0);
});

for (const failure of ["disconnected", "no heartbeat", "never joined"]) {
  test(`watchdog exits a stuck client: ${failure}`, async () => {
    const h = healthHarness();
    if (failure !== "never joined") h.connect();
    else h.client.emit("connected");
    if (failure === "disconnected") {
      h.client.reconnect = false; // tmi disables this after failed authentication.
      h.client.emit("disconnected", "Login authentication failed");
    }
    h.setNow(180_000);
    await h.check();
    assert.equal(h.failures.length, 1);
    assert.equal(h.timers.jobs.size, 0);
  });
}

test("a successful reconnect cancels the disconnected deadline", async () => {
  const h = healthHarness();
  h.connect();
  h.client.emit("disconnected", "network dropped");
  h.setNow(120_000); h.connect();
  h.setNow(200_000); h.client.emit("pong"); await h.check();
  assert.equal(h.failures.length, 0);
  h.runtime.stop();
});

test("concurrent maintenance checks coalesce and a fatal token failure exits once", async () => {
  const pending = deferred();
  let calls = 0;
  const h = healthHarness(() => { calls += 1; return pending.promise; });
  const first = h.runtime.checkTokens();
  const second = h.runtime.checkTokens();
  assert.equal(calls, 1);
  pending.reject(new Error("refresh grant revoked"));
  await Promise.all([first, second]);
  assert.equal(h.failures.length, 1);
  assert.equal(h.timers.jobs.size, 0);
});

test("real tmi.js reconnect obtains a fresh password without replacing the client", { timeout: 8_000 }, async (t) => {
  let token = "first-fake-token";
  const { createChatClient } = loadModule("utils/botRuntime.js", {
    "../tokenManager": { ensureValidToken: async () => ({ accessToken: token }) },
  });
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const passwords = [];
  const sockets = [];
  server.on("connection", (socket) => {
    sockets.push(socket);
    socket.on("message", (bytes) => {
      const message = bytes.toString();
      if (message.startsWith("PASS ")) passwords.push(message.slice(5));
      if (message.startsWith("NICK ")) {
        socket.send(":tmi.twitch.tv 001 tester :Welcome\r\n:tmi.twitch.tv 376 tester :End of MOTD\r\n");
      }
      if (message.startsWith("JOIN ")) {
        socket.send(":tester!tester@tester.tmi.twitch.tv JOIN #channel\r\n:tmi.twitch.tv ROOMSTATE #channel\r\n");
      }
    });
  });
  const client = createChatClient({ username: "tester", channel: "channel", profile: "bot" });
  client.secure = false;
  client.opts.connection.server = "127.0.0.1";
  client.opts.connection.port = server.address().port;
  client.reconnectInterval = client.reconnectTimer = client.maxReconnectInterval = 20;
  client.log = { info() {}, warn() {}, error() {} };
  t.after(async () => {
    client.reconnect = false;
    try { await client.disconnect(); } catch {}
    for (const socket of sockets) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
  });
  const joined = once(client, "roomstate");
  await client.connect(); await joined;
  token = "second-fake-token";
  const rejoined = once(client, "roomstate");
  sockets[0].terminate();
  await rejoined;
  assert.deepEqual(passwords, ["oauth:first-fake-token", "oauth:second-fake-token"]);
});

test("kernel instance lock rejects a duplicate and releases after SIGKILL", { timeout: 8_000 }, async (t) => {
  const filename = path.join(root, "utils/botRuntime.js");
  const args = `require(${JSON.stringify(filename)}).requireSingleInstance('test-bot', 'test-${process.pid}');`;
  const holder = spawn(process.execPath, ["-e", args + "process.stdout.write('locked\\n');setInterval(()=>{},1000)"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => { if (holder.exitCode === null) holder.kill("SIGKILL"); });
  await once(holder.stdout, "data");
  const duplicate = spawnSync(process.execPath, ["-e", args], { encoding: "utf8", timeout: 3_000 });
  assert.equal(duplicate.status, 73);
  assert.match(duplicate.stderr, /Another copy is already running/);
  const exit = once(holder, "exit"); holder.kill("SIGKILL"); await exit;
  const replacement = spawnSync(process.execPath, ["-e", args], { encoding: "utf8", timeout: 3_000 });
  assert.equal(replacement.status, 0, replacement.stderr);
});

test("service logging writes each changed row once", () => {
  const logs = [];
  const { setStatusLine } = loadModule("utils/logger.js", {}, {
    process: { stdout: { isTTY: false } }, console: { log: (line) => logs.push(line) },
  });
  setStatusLine("TEST", "Status", "Running");
  setStatusLine("TEST", "XP", "10");
  setStatusLine("TEST", "XP", "10");
  setStatusLine("TEST", "XP", "20");
  assert.equal(logs.length, 3);
});
