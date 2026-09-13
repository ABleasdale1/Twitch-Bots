const test = require("node:test");
const assert = require("node:assert/strict");
const { joinHarness, deferred, flush } = require("./helpers");

test("repeated maintenance never creates extra clients or chat listeners", async () => {
  const bot = await joinHarness();
  for (let i = 0; i < 5; i += 1) await bot.command("refresh");
  assert.equal(bot.clients.length, 2);
  assert.equal(bot.tokenChecks, 5);
  for (const client of bot.clients) assert.equal(client.connectCount, 1);
  assert.equal(bot.joiner.listenerCount("message"), 1);
  assert.equal(bot.host.listenerCount("message"), 0);
});

test("redelivered admin command produces exactly one chat response", async () => {
  const bot = await joinHarness();
  await bot.message("same-id", "~ar status");
  await bot.message("same-id", "~ar status");
  assert.equal(bot.host.sent.length, 1);
  await bot.message("new-id", "~ar status");
  assert.equal(bot.host.sent.length, 2);
});

test("duplicate Tangia triggers join once per enabled account", async () => {
  const bot = await joinHarness();
  await bot.message("event-a", "Someone started a tangia dungeon", "tangiabot");
  await bot.message("event-a", "Someone started a tangia dungeon", "tangiabot");
  await bot.message("event-b", "Someone started a tangia dungeon", "tangiabot");
  assert.equal(bot.timers.jobs.size, 1);
  await bot.timers.fire([...bot.timers.jobs.keys()][0]);
  assert.deepEqual(bot.host.sent, ["!join"]);
  assert.deepEqual(bot.joiner.sent, ["!join"]);
  assert.equal(bot.failures.length, 0);
});

test("concurrent raffle attempts send one raffle command", async () => {
  const bot = await joinHarness();
  const live = deferred();
  bot.setLiveCheck(() => live.promise);
  await bot.command("ar on");
  const first = bot.run();
  const second = bot.run();
  await flush();
  live.resolve(true);
  await Promise.all([first, second]);
  assert.deepEqual(bot.host.sent, ["!raffle 100000 60"]);
});

for (const reenable of [false, true]) {
  test(`ar off cancels an in-flight live check${reenable ? " even if immediately re-enabled" : ""}`, async () => {
    const bot = await joinHarness();
    const live = deferred();
    bot.setLiveCheck(() => live.promise);
    await bot.command("ar on");
    const run = bot.run();
    await flush();
    await bot.command("ar off");
    if (reenable) await bot.command("ar on");
    live.resolve(true);
    await run;
    assert.equal(bot.host.sent.length, 0);
    if (reenable) {
      await bot.run();
      assert.equal(bot.host.sent.length, 1);
    }
  });
}

for (const offCommand of ["ar off", "aj off"]) {
  test(`${offCommand} cancels a pending personal raffle join`, async () => {
    const bot = await joinHarness();
    await bot.command("ar on");
    await bot.command("aj on");
    await bot.run();
    const joinTimer = [...bot.timers.jobs].find(([, job]) => job.ms <= 58_000)?.[0];
    assert.ok(joinTimer);
    await bot.command(offCommand);
    await bot.timers.fire(joinTimer);
    assert.equal(bot.joiner.sent.length, 0);
  });
}

test("a failed live check skips a slot; offline disables auto raffle", async () => {
  const bot = await joinHarness();
  await bot.command("ar on");
  bot.setLiveCheck(async () => { throw new Error("temporary network failure"); });
  await bot.run();
  assert.equal(bot.state.enabled, true);
  assert.equal(bot.host.sent.length, 0);
  bot.setLiveCheck(async () => true);
  await bot.run();
  assert.equal(bot.host.sent.length, 1);
  bot.setLiveCheck(async () => false);
  await bot.run();
  assert.equal(bot.state.enabled, false);
  assert.equal(bot.timers.jobs.size, 0);
});

test("repeated ar on commands keep one initial timer and one recurring timer", async () => {
  const bot = await joinHarness();
  await bot.command("ar on");
  await bot.command("ar on");
  assert.equal(bot.timers.jobs.size, 1);
  const [timer, job] = [...bot.timers.jobs][0];
  assert.equal(job.ms, 600_000);
  await bot.timers.fire(timer);
  await flush();
  assert.equal(bot.host.sent.length, 1);
  assert.equal(bot.timers.jobs.size, 1);
  assert.equal([...bot.timers.jobs.values()][0].ms, 1_800_000);
});
