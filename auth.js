// auth.js
// Usage:
//   node auth.js bot   -> authorise rynoxbot, prints ACCESS_TOKEN / REFRESH_TOKEN
//   node auth.js join  -> authorise itsnotrynox, prints JOIN_ACCESS_TOKEN / JOIN_REFRESH_TOKEN

require("dotenv").config();

const http = require("http");
const { URL } = require("url");

const { CLIENT_ID, CLIENT_SECRET } = process.env;

const redirectUri = "http://localhost:3000";
const profile = (process.argv[2] || "bot").toLowerCase();

const profiles = {
  bot: {
    label: "BOT / MOD account",
    expectedUsernameEnv: "BOT_USERNAME",
    accessTokenKey: "ACCESS_TOKEN",
    refreshTokenKey: "REFRESH_TOKEN",
    scopes: [
      "chat:read",
      "chat:edit",
      "moderator:manage:chat_messages",
      "moderator:manage:warnings",
      "moderator:manage:banned_users",
    ],
  },
  join: {
    label: "JOIN / PERSONAL account",
    expectedUsernameEnv: "JOIN_USERNAME",
    accessTokenKey: "JOIN_ACCESS_TOKEN",
    refreshTokenKey: "JOIN_REFRESH_TOKEN",
    scopes: ["chat:read", "chat:edit"],
  },
};

const selected = profiles[profile];

if (!selected) {
  console.error("Unknown auth profile.");
  console.error("Use one of:");
  console.error("  node auth.js bot");
  console.error("  node auth.js join");
  process.exit(1);
}

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Missing CLIENT_ID or CLIENT_SECRET in .env");
  process.exit(1);
}

const expectedUsername = process.env[selected.expectedUsernameEnv] || "unknown";
const scopes = selected.scopes.join(" ");

const authUrl =
  "https://id.twitch.tv/oauth2/authorize" +
  `?client_id=${encodeURIComponent(CLIENT_ID)}` +
  `&redirect_uri=${encodeURIComponent(redirectUri)}` +
  "&response_type=code" +
  `&scope=${encodeURIComponent(scopes)}`;

console.log(`\nAuthorising profile: ${profile}`);
console.log(`Account type: ${selected.label}`);
console.log(`Expected Twitch account: ${expectedUsername}`);
console.log(
  "\nIMPORTANT: open this URL while logged into the matching Twitch account.\n"
);
console.log(authUrl);
console.log("\nWaiting for Twitch redirect on http://localhost:3000 ...\n");

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, redirectUri);
  const code = reqUrl.searchParams.get("code");

  if (!code) {
    res.writeHead(400);
    res.end("Missing code");
    return;
  }

  try {
    const tokenResponse = await fetch("https://id.twitch.tv/oauth2/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
      }),
    });

    const data = await tokenResponse.json();

    if (!tokenResponse.ok) {
      console.error(data);
      res.writeHead(500);
      res.end("Token exchange failed. Check terminal.");
      return;
    }

    console.log("\nSUCCESS. Copy these into your .env:\n");
    console.log(`${selected.accessTokenKey}=${data.access_token}`);
    console.log(`${selected.refreshTokenKey}=${data.refresh_token || ""}`);

    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Success. You can close this tab and check your terminal.");

    server.close();
  } catch (error) {
    console.error(error);
    res.writeHead(500);
    res.end("Error. Check terminal.");
  }
});

server.listen(3000);
