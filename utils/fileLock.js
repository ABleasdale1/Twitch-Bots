// Linux kernel locks are automatically released if Node crashes or is killed.
// Keep the lock file in place; unlinking it would allow two different locks.
const fs = require("fs");
const { spawnSync } = require("child_process");

function tryFileLock(lockPath) {
  const fd = fs.openSync(lockPath, "a", 0o600);
  const result = spawnSync(
    "flock",
    ["--nonblock", "--conflict-exit-code", "73", "3"],
    {
      stdio: ["ignore", "pipe", "pipe", fd],
      timeout: 5_000,
    }
  );

  if (result.error || result.status !== 0) {
    fs.closeSync(fd);

    if (result.status === 73) {
      return null;
    }

    throw new Error(
      `Cannot acquire Linux file lock: ${
        result.error?.message || "install/check util-linux (flock)"
      }`
    );
  }

  let released = false;

  return {
    release() {
      if (!released) {
        released = true;
        fs.closeSync(fd);
      }
    },
  };
}

async function acquireFileLock(lockPath, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;

  do {
    const lock = tryFileLock(lockPath);

    if (lock) {
      return lock;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  } while (Date.now() < deadline);

  throw new Error("Timed out waiting for the shared token refresh lock");
}

module.exports = {
  tryFileLock,
  acquireFileLock,
};
