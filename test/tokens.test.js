const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const dotenv = require("dotenv");
const { root, loadModule } = require("./helpers");

function tokenFixture(t, fetch) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "twitch-token-test-"));

  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const envPath = path.join(dir, ".env");
  const envContents =
    "# Keep this comment\n" +
    "CLIENT_ID=fake\n" +
    "CLIENT_SECRET=fake\n" +
    'ACCESS_TOKEN = "old-bot"\n' +
    "REFRESH_TOKEN=bot-refresh\n" +
    "JOIN_ACCESS_TOKEN=old-join\n" +
    "JOIN_REFRESH_TOKEN=join-refresh\n";

  fs.writeFileSync(envPath, envContents);

  const manager = loadModule(
    "tokenManager.js",
    {},
    {
      __dirname: dir,
      process: {
        pid: process.pid,
        env: {
          CLIENT_ID: "fake",
          CLIENT_SECRET: "fake",
        },
      },
      fetch,
    }
  );

  return { dir, envPath, manager };
}

test("parallel checks refresh one token and preserve the other profile", async (t) => {
  let refreshes = 0;

  const fixture = tokenFixture(t, async (url) => {
    if (String(url).endsWith("/validate")) {
      return new Response("{}", { status: 401 });
    }

    refreshes += 1;

    return Response.json({
      access_token: "new-bot",
      refresh_token: "new-refresh",
      expires_in: 3600,
    });
  });

  const results = await Promise.all([
    fixture.manager.ensureValidToken("bot"),
    fixture.manager.ensureValidToken("bot"),
  ]);

  assert.equal(refreshes, 1);
  assert.ok(results.every((result) => result.accessToken === "new-bot"));

  const text = fs.readFileSync(fixture.envPath, "utf8");
  const parsed = dotenv.parse(text);

  assert.equal(parsed.ACCESS_TOKEN, "new-bot");
  assert.equal(parsed.JOIN_ACCESS_TOKEN, "old-join");
  assert.match(text, /# Keep this comment/);
  assert.equal(fs.statSync(fixture.envPath).mode & 0o777, 0o600);
});

for (const failure of ["network", "invalid JSON", "HTTP 503"]) {
  test(`temporary validation failure keeps the token: ${failure}`, async (t) => {
    const fixture = tokenFixture(t, async (url) => {
      assert.ok(
        String(url).endsWith("/validate"),
        "must not refresh on a temporary failure"
      );

      if (failure === "network") {
        throw new Error("network unavailable");
      }

      return new Response(
        failure === "invalid JSON" ? "not json" : "unavailable",
        {
          status: failure === "HTTP 503" ? 503 : 200,
        }
      );
    });

    const result = await fixture.manager.ensureValidToken("bot");
    assert.equal(result.accessToken, "old-bot");
    assert.equal(result.temporaryFailure, true);
  });
}

test("a rotated token is read from disk, including quoted dotenv values", (t) => {
  const fixture = tokenFixture(t, async () => {
    throw new Error("no network expected");
  });

  assert.equal(fixture.manager.getAccessToken("bot"), "old-bot");
  fs.appendFileSync(fixture.envPath, '\nACCESS_TOKEN="new-from-other-process"\n');
  assert.equal(fixture.manager.getAccessToken("bot"), "new-from-other-process");
});

test(
  "two real Node processes refreshing different profiles retain BOTH new tokens",
  { timeout: 10_000 },
  async (t) => {
    const fixture = tokenFixture(t, async () => {});

    fs.copyFileSync(
      path.join(root, "tokenManager.js"),
      path.join(fixture.dir, "tokenManager.js")
    );
    fs.mkdirSync(path.join(fixture.dir, "utils"));
    fs.copyFileSync(
      path.join(root, "utils/fileLock.js"),
      path.join(fixture.dir, "utils/fileLock.js")
    );
    fs.symlinkSync(
      path.join(root, "node_modules"),
      path.join(fixture.dir, "node_modules"),
      "dir"
    );

    const worker = `
      require("dotenv").config({ quiet: true });

      global.fetch = async (url, options) => {
        await new Promise((resolve) => setTimeout(resolve, 30));

        if (url.endsWith("/validate")) {
          return options.headers.Authorization.includes("new-")
            ? Response.json({ expires_in: 3600 })
            : new Response("{}", { status: 401 });
        }

        const name = options.body.get("refresh_token").startsWith("bot")
          ? "bot"
          : "join";

        return Response.json({
          access_token: "new-" + name,
          refresh_token: "new-refresh-" + name,
          expires_in: 3600,
        });
      };

      require("./tokenManager")
        .ensureValidToken(process.argv[1])
        .catch((error) => {
          console.error(error.message);
          process.exit(1);
        });
    `;

    const run = (profile) =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["-e", worker, profile], {
          cwd: fixture.dir,
          stdio: ["ignore", "ignore", "pipe"],
        });

        let error = "";

        child.stderr.on("data", (data) => {
          error += data;
        });
        child.on("error", reject);
        child.on("exit", (code) => {
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(error || `exit ${code}`));
          }
        });
      });

    await Promise.all([run("bot"), run("join")]);

    const parsed = dotenv.parse(fs.readFileSync(fixture.envPath));

    assert.equal(parsed.ACCESS_TOKEN, "new-bot");
    assert.equal(parsed.JOIN_ACCESS_TOKEN, "new-join");
    assert.equal(parsed.REFRESH_TOKEN, "new-refresh-bot");
    assert.equal(parsed.JOIN_REFRESH_TOKEN, "new-refresh-join");
  }
);

test("Helix reloads tokens and retries a 401 once with the renewed token", async () => {
  const headers = [];

  const { isStreamLive } = loadModule(
    "utils/twitchApi.js",
    {
      "../tokenManager": {
        getAccessToken: () => "disk-token",
        ensureValidToken: async () => ({ accessToken: "renewed-token" }),
      },
    },
    {
      fetch: async (url, options) => {
        headers.push(options.headers.Authorization);
        assert.ok(options.signal);

        if (headers.length === 1) {
          return new Response("{}", { status: 401 });
        }

        return Response.json({ data: [{ id: "fake" }] });
      },
    }
  );

  assert.equal(
    await isStreamLive({
      broadcasterId: "fake",
      tokenProfile: "bot",
      clientId: "fake",
    }),
    true
  );
  assert.deepEqual(headers, ["Bearer disk-token", "Bearer renewed-token"]);
});

test("a timed-out moderation POST is not sent a second time", async () => {
  let calls = 0;

  const { warnUser } = loadModule(
    "utils/twitchApi.js",
    {
      "../tokenManager": {
        getAccessToken: () => "fake",
      },
    },
    {
      fetch: async () => {
        calls += 1;
        throw new Error("request timed out");
      },
    }
  );

  await assert.rejects(
    warnUser({ userId: "fake", tokenProfile: "bot" }),
    /timed out/
  );
  assert.equal(calls, 1);
});
