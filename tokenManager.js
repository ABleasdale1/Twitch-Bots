// tokenManager.js
//
// Shared Twitch token handling. Validate at login and during maintenance.
// All profiles share one kernel lock because they write the SAME .env file.
// The kernel releases the lock on crashes, without stale PID/lock races.

const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const { acquireFileLock } = require("./utils/fileLock");

const envPath = path.join(__dirname, ".env");

const TOKEN_PROFILES = {
  bot: {
    label: "BOT",
    accessTokenKey: "ACCESS_TOKEN",
    refreshTokenKey: "REFRESH_TOKEN",
  },
  join: {
    label: "JOINER",
    accessTokenKey: "JOIN_ACCESS_TOKEN",
    refreshTokenKey: "JOIN_REFRESH_TOKEN",
  },
};

const MINIMUM_TOKEN_LIFETIME_SECONDS = 5 * 60;
const checksInFlight = new Map();

function getProfile(profileName) {
  const profile = TOKEN_PROFILES[profileName];

  if (!profile) {
    throw new Error(`Unknown token profile: ${profileName}`);
  }

  return profile;
}

function updateEnvValue(content, key, value) {
  const safeValue = String(value).replace(/[\r\n]/g, "").trim();
  const regex = new RegExp(`^(?:export\\s+)?${key}\\s*=.*$`, "gm");
  if (regex.test(content)) return content.replace(regex, () => `${key}=${safeValue}`);
  return `${content}${content && !content.endsWith("\n") ? "\n" : ""}${key}=${safeValue}\n`;
}

function reloadProfileFromEnvFile(profile) {
  const parsed = dotenv.parse(fs.readFileSync(envPath, "utf8"));
  for (const key of [profile.accessTokenKey, profile.refreshTokenKey]) {
    // Do not keep a token in memory after it was removed from .env.
    if (parsed[key] === undefined) delete process.env[key];
    else process.env[key] = parsed[key];
  }
}

function getAccessToken(profileName = "bot") {
  const profile = getProfile(profileName);
  reloadProfileFromEnvFile(profile);
  return process.env[profile.accessTokenKey];
}

async function validateToken(accessToken) {
  if (!accessToken) {
    return {
      valid: false,
      status: 401,
      reason: "missing access token",
    };
  }

  let response;

  try {
    response = await fetch(
      "https://id.twitch.tv/oauth2/validate",
      {
        headers: {
          Authorization: `OAuth ${accessToken}`,
        },
        signal: AbortSignal.timeout(15_000),
      }
    );
  } catch (error) {
    return {
      valid: null,
      status: null,
      temporaryFailure: true,
      reason: `validation request failed: ${error.message}`,
    };
  }

  if (response.status === 401) {
    return {
      valid: false,
      status: 401,
      reason: "token rejected by Twitch",
    };
  }

  if (!response.ok) {
    return {
      valid: null,
      status: response.status,
      temporaryFailure: true,
      reason:
        `validation endpoint returned ` +
        `${response.status} ${response.statusText}`,
    };
  }

  let data;
  try {
    data = await response.json();
    if (!Number.isFinite(Number(data.expires_in))) throw new Error("missing token lifetime");
  } catch (error) {
    return {
      valid: null, temporaryFailure: true, status: response.status,
      reason: `validation response could not be read: ${error.message}`,
    };
  }

  return {
    valid: true,
    status: 200,
    expiresIn: Number(data.expires_in) || 0,
    login: data.login || null,
    userId: data.user_id || null,
    clientId: data.client_id || null,
    scopes: Array.isArray(data.scopes) ? data.scopes : [],
  };
}

async function performRefresh(profileName, profile) {
  reloadProfileFromEnvFile(profile);

  const clientId = process.env.CLIENT_ID;
  const clientSecret = process.env.CLIENT_SECRET;
  const currentRefreshToken = process.env[profile.refreshTokenKey];

  if (!clientId || !clientSecret || !currentRefreshToken) {
    throw new Error(
      `Missing CLIENT_ID, CLIENT_SECRET, or ` +
      `${profile.refreshTokenKey} in .env`
    );
  }

  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: currentRefreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });

  const response = await fetch(
    "https://id.twitch.tv/oauth2/token",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params,
      signal: AbortSignal.timeout(20_000),
    }
  );

  if (!response.ok) {
    throw new Error(
      `Token refresh failed: HTTP ${response.status}. ` +
      ((response.status === 400 || response.status === 401)
        ? `Check credentials or re-authorise with node auth.js ${profileName}`
        : "Temporary Twitch error; the service will retry")
    );
  }

  const data = await response.json();

  if (!data.access_token) {
    throw new Error(
      "Twitch refresh response contained no access token"
    );
  }

  const newAccessToken = data.access_token;
  const newRefreshToken =
    data.refresh_token || currentRefreshToken;

  let envContent = fs.readFileSync(envPath, "utf8");

  envContent = updateEnvValue(
    envContent,
    profile.accessTokenKey,
    newAccessToken
  );
  envContent = updateEnvValue(
    envContent,
    profile.refreshTokenKey,
    newRefreshToken
  );

  const temporaryEnvPath =
    `${envPath}.${process.pid}.tmp`;

  fs.writeFileSync(
    temporaryEnvPath,
    envContent,
    {
      encoding: "utf8",
      mode: 0o600,
    }
  );

  fs.renameSync(temporaryEnvPath, envPath);

  process.env[profile.accessTokenKey] = newAccessToken;
  process.env[profile.refreshTokenKey] = newRefreshToken;

  return {
    accessToken: newAccessToken,
    refreshToken: newRefreshToken,
    refreshed: true,
    validated: true,
    expiresIn: Number(data.expires_in) || null,
  };
}

async function refreshTokens(profileName = "bot") {
  const profile = getProfile(profileName);
  const lock = await acquireFileLock(path.join(__dirname, ".token-refresh.lock"));

  try {
    reloadProfileFromEnvFile(profile);

    // Another service may have refreshed it while this process waited.
    const currentAccessToken =
      process.env[profile.accessTokenKey];

    const validation =
      await validateToken(currentAccessToken);

    if (
      validation.valid === true &&
      validation.expiresIn >
        MINIMUM_TOKEN_LIFETIME_SECONDS
    ) {
      return {
        accessToken: currentAccessToken,
        refreshToken:
          process.env[profile.refreshTokenKey],
        refreshed: false,
        validated: true,
        expiresIn: validation.expiresIn,
      };
    }

    if (validation.valid === null) {
      // Twitch/network is temporarily unavailable. Do not rotate a token
      // merely because validation could not be completed.
      return {
        accessToken: currentAccessToken,
        refreshToken:
          process.env[profile.refreshTokenKey],
        refreshed: false,
        validated: false,
        temporaryFailure: true,
        warning: validation.reason,
      };
    }

    console.log(
      `[${profile.label}] Token invalid or expiring; refreshing...`
    );

    return await performRefresh(profileName, profile);
  } finally {
    lock.release();
  }
}

async function checkToken(profileName = "bot") {
  const profile = getProfile(profileName);

  reloadProfileFromEnvFile(profile);

  const accessToken =
    process.env[profile.accessTokenKey];

  const validation =
    await validateToken(accessToken);

  if (
    validation.valid === true &&
    validation.expiresIn >
      MINIMUM_TOKEN_LIFETIME_SECONDS
  ) {
    return {
      accessToken,
      refreshToken:
        process.env[profile.refreshTokenKey],
      refreshed: false,
      validated: true,
      expiresIn: validation.expiresIn,
    };
  }

  if (validation.valid === null && accessToken) {
    console.warn(
      `[${profile.label}] ${validation.reason}; ` +
      `continuing with the current token`
    );

    return {
      accessToken,
      refreshToken:
        process.env[profile.refreshTokenKey],
      refreshed: false,
      validated: false,
      temporaryFailure: true,
      warning: validation.reason,
    };
  }

  return refreshTokens(profileName);
}

// Coalesce reconnect/maintenance/API checks within each process as well.
function ensureValidToken(profileName = "bot") {
  if (!checksInFlight.has(profileName)) {
    checksInFlight.set(profileName, checkToken(profileName).finally(() => checksInFlight.delete(profileName)));
  }
  return checksInFlight.get(profileName);
}

module.exports = {
  ensureValidToken,
  refreshTokens,
  validateToken,
  getAccessToken,
};
