// Cloudflare Worker entry point.
// - fetch: Discord sends every slash command here as an HTTP request.
// - scheduled: runs every minute to post due reminders and to re-register
//   slash commands if a deploy changed them.

import { ask } from "./commands/ask.js";
import { decide } from "./commands/decide.js";
import { eli5 } from "./commands/eli5.js";
import { event } from "./commands/event.js";
import { food } from "./commands/food.js";
import { imagine } from "./commands/imagine.js";
import { postDueReminders, remind } from "./commands/remind.js";
import { research } from "./commands/research.js";
import { roast } from "./commands/roast.js";
import { tldr } from "./commands/tldr.js";
import { trivia } from "./commands/trivia.js";
import {
  EPHEMERAL,
  InteractionType,
  NO_MENTIONS,
  ResponseType,
  editOriginal,
  verifyDiscordRequest,
} from "./discord.js";
import { registerCommands, syncCommandsIfChanged } from "./register.js";

export const HANDLERS = {
  ask,
  tldr,
  event,
  remind,
  research,
  eli5,
  decide,
  trivia,
  imagine,
  food,
  roast,
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

async function runCommand(handler, interaction, env) {
  try {
    await handler(interaction, env);
  } catch (err) {
    console.error(`/${interaction.data.name} failed:`, err);
    await editOriginal(env, interaction, {
      content: `⚠️ Sorry, something went wrong: ${String(err.message).slice(0, 300)}`,
      allowed_mentions: NO_MENTIONS,
    }).catch((e) => console.error("Couldn't report the error to Discord:", e));
  }
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "GET") return new Response("Discord AI bot is running 🤖");
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

    const { valid, body } = await verifyDiscordRequest(request, env.DISCORD_PUBLIC_KEY);
    if (!valid) return new Response("Invalid request signature", { status: 401 });

    const interaction = JSON.parse(body);

    // Discord pings the endpoint when you save it in the developer portal.
    // We use that moment to (re)register the slash commands, so there's no
    // separate setup step. Re-registering the same commands is harmless.
    if (interaction.type === InteractionType.PING) {
      ctx.waitUntil(
        registerCommands(env, interaction.application_id).catch((err) =>
          console.error("Registering slash commands failed:", err),
        ),
      );
      return json({ type: ResponseType.PONG });
    }

    if (interaction.type === InteractionType.APPLICATION_COMMAND) {
      const handler = HANDLERS[interaction.data.name];
      if (!handler) {
        return json({
          type: ResponseType.CHANNEL_MESSAGE,
          data: { content: "I don't know that command.", flags: EPHEMERAL },
        });
      }
      // Discord needs an answer within 3 seconds, so reply "thinking…" now
      // and finish the real work in the background.
      ctx.waitUntil(runCommand(handler, interaction, env));
      return json({ type: ResponseType.DEFERRED_CHANNEL_MESSAGE });
    }

    return new Response("Unsupported interaction type", { status: 400 });
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(postDueReminders(env));
    ctx.waitUntil(
      syncCommandsIfChanged(env).catch((err) => console.error("Syncing slash commands failed:", err)),
    );
  },
};
