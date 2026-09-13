require("dotenv").config();

const {
  CLIENT_ID,
  ACCESS_TOKEN,
  TWITCH_CHANNEL,
  BOT_USERNAME,
} = process.env;

async function getUser(login) {
  const res = await fetch(
    `https://api.twitch.tv/helix/users?login=${encodeURIComponent(login)}`,
    {
      headers: {
        "Client-Id": CLIENT_ID,
        Authorization: `Bearer ${ACCESS_TOKEN}`,
      },
    }
  );

  const data = await res.json();

  if (!res.ok) {
    throw new Error(JSON.stringify(data, null, 2));
  }

  if (!data.data || data.data.length === 0) {
    throw new Error(`No Twitch user found for login: ${login}`);
  }

  return data.data[0];
}

async function main() {
  const broadcaster = await getUser(TWITCH_CHANNEL);
  const bot = await getUser(BOT_USERNAME);

  console.log("\nCopy these into your .env:\n");
  console.log(`BROADCASTER_ID=${broadcaster.id}`);
  console.log(`MODERATOR_ID=${bot.id}`);

  console.log("\nDetails:");
  console.log({
    broadcaster: {
      login: broadcaster.login,
      display_name: broadcaster.display_name,
      id: broadcaster.id,
    },
    bot: {
      login: bot.login,
      display_name: bot.display_name,
      id: bot.id,
    },
  });
}

main().catch((err) => {
  console.error("Failed:", err.message);
});