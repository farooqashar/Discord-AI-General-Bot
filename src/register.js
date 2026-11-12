// Keeps Discord's list of slash commands in sync with command-definitions.js.

import { COMMANDS } from "./command-definitions.js";
import { discordApi } from "./discord.js";

const META_KEY = "registered_commands";

export async function registerCommands(env, applicationId) {
  const registered = await discordApi(env, `/applications/${applicationId}/commands`, {
    method: "PUT",
    body: COMMANDS,
  });
  console.log(`Registered ${registered.length} slash commands`);
  if (env.DB) {
    await env.DB.prepare(
      "INSERT INTO meta (key, value, updated_at) VALUES (?, ?, unixepoch()) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    )
      .bind(META_KEY, JSON.stringify(COMMANDS))
      .run();
  }
}

/**
 * Called every minute by the cron trigger. If a deploy changed the commands
 * since they were last registered, register the new set. Otherwise it's a
 * single cheap database read.
 */
export async function syncCommandsIfChanged(env) {
  if (!env.DB || !env.DISCORD_APP_ID) return;
  const row = await env.DB.prepare("SELECT value FROM meta WHERE key = ?").bind(META_KEY).first();
  if (row?.value === JSON.stringify(COMMANDS)) return;
  await registerCommands(env, env.DISCORD_APP_ID);
}
