// Registers (or updates) the bot's slash commands with Discord.
// Run once after setup, and again whenever you change src/command-definitions.js:
//   npm run register

import { COMMANDS } from "../src/command-definitions.js";

const { DISCORD_APP_ID, DISCORD_TOKEN, DISCORD_GUILD_ID } = process.env;

if (!DISCORD_APP_ID || !DISCORD_TOKEN) {
  console.error("Missing DISCORD_APP_ID or DISCORD_TOKEN. Add them to .dev.vars (see .dev.vars.example).");
  process.exit(1);
}

// Server ("guild") commands show up instantly; global ones can take up to an hour.
const url = DISCORD_GUILD_ID
  ? `https://discord.com/api/v10/applications/${DISCORD_APP_ID}/guilds/${DISCORD_GUILD_ID}/commands`
  : `https://discord.com/api/v10/applications/${DISCORD_APP_ID}/commands`;

const res = await fetch(url, {
  method: "PUT",
  headers: { Authorization: `Bot ${DISCORD_TOKEN}`, "Content-Type": "application/json" },
  body: JSON.stringify(COMMANDS),
});

if (!res.ok) {
  console.error(`Registering commands failed (${res.status}):`, await res.text());
  process.exit(1);
}

const registered = await res.json();
const where = DISCORD_GUILD_ID ? `server ${DISCORD_GUILD_ID}` : "all servers (global)";
console.log(`Registered ${registered.length} commands for ${where}:`);
for (const cmd of registered) console.log(`  /${cmd.name} — ${cmd.description}`);
