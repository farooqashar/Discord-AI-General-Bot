// Cloudflare Worker entry point.
// - fetch: Discord sends every slash command here as an HTTP request.
// - scheduled: runs every minute to post due reminders, answer @mentions in
//   channels turned on with /listen, and re-register slash commands if a
//   deploy changed them.

import { ask } from "./commands/ask.js";
import { decide } from "./commands/decide.js";
import { digest, postDueDigests } from "./commands/digest.js";
import { eli5 } from "./commands/eli5.js";
import { event } from "./commands/event.js";
import { food } from "./commands/food.js";
import { listen, pollMentions } from "./commands/listen.js";
import { postDueReminders, remind } from "./commands/remind.js";
import { research } from "./commands/research.js";
import { roast } from "./commands/roast.js";
import { channelIsPublic, stats } from "./commands/stats.js";
import { summarize } from "./commands/summarize.js";
import { tldr } from "./commands/tldr.js";
import { trivia } from "./commands/trivia.js";
import { vibeCheck } from "./commands/vibe-check.js";
import { weather } from "./commands/weather.js";
import { postDueWrapped, wrapped } from "./commands/wrapped.js";
import {
  EPHEMERAL,
  InteractionType,
  NO_MENTIONS,
  ResponseType,
  UserFacingError,
  editOriginal,
  getOption,
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
  food,
  summarize,
  "vibe-check": vibeCheck,
  weather,
  listen,
  stats,
  digest,
  wrapped,
  roast,
};

function friendlyError(err) {
  if (err instanceof UserFacingError) return err.message;
  if (err.status === 403) return "I don't have permission to do that here. Ask a server admin to check my role's permissions.";
  return `Sorry, something went wrong. Please try again in a bit. (ref: ${errorRef(err)})`;
}

/** A short, harmless hint about what failed, e.g. "discord-429", "ai-500", "limit". */
export function errorRef(err) {
  const msg = String(err?.message ?? "");
  if (/too many subrequests/i.test(msg)) return "limit";
  if (/rate limited/i.test(msg)) return "discord-429";
  if (msg.startsWith("Discord ") && err.status) return `discord-${err.status}`;
  if (msg.startsWith("AI request failed")) return `ai-${msg.match(/\((\d+)\)/)?.[1] ?? "x"}`;
  if (msg.startsWith("Weather service")) return "weather";
  return (err?.name || "error").toLowerCase().slice(0, 20);
}

export const SCHEDULED_POSTS_CRON = "*/5 * * * *";

/** One Wrapped per run if any is due (it reads many channels); otherwise digests. */
export async function runScheduledPosts(env) {
  try {
    if (await postDueWrapped(env)) return;
    await postDueDigests(env);
  } catch (err) {
    console.error("Scheduled posts failed:", err);
  }
}

// Commands whose `channel` option reads another channel and posts what it
// finds where the command was run.
const READS_OTHER_CHANNELS = new Set(["ask", "tldr", "vibe-check", "roast", "stats"]);
const PRIVACY_CHECK_MS = 1500;

/**
 * Flags for the deferred reply. Reading another channel is only posted
 * publicly when everyone in the server can read that channel; otherwise only
 * the asker sees the reply, so a private channel never leaks into a public
 * one. This has to be decided before the 3-second deadline, because a reply
 * can't switch between public and ephemeral later. If the check fails or is
 * slow, the reply is ephemeral.
 */
export async function replyFlags(interaction, env) {
  if (!READS_OTHER_CHANNELS.has(interaction.data.name)) return undefined;
  const channelId = getOption(interaction, "channel");
  if (!channelId || channelId === interaction.channel_id) return undefined;
  if (!interaction.guild_id) return EPHEMERAL;
  let timer;
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("timed out")), PRIVACY_CHECK_MS);
    });
    const isPublic = await Promise.race([channelIsPublic(env, interaction.guild_id, channelId), timeout]);
    return isPublic ? undefined : EPHEMERAL;
  } catch (err) {
    console.warn(`Couldn't check whether channel ${channelId} is public; replying privately:`, err.message);
    return EPHEMERAL;
  } finally {
    clearTimeout(timer);
  }
}

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

async function runCommand(handler, interaction, env) {
  try {
    await handler(interaction, env);
  } catch (err) {
    // Full details go to the Cloudflare logs; Discord only gets a friendly message.
    console.error(`/${interaction.data.name} failed:`, err);
    await editOriginal(env, interaction, {
      content: `⚠️ ${friendlyError(err)}`,
      allowed_mentions: NO_MENTIONS,
    }).catch((e) => console.error("Couldn't report the error to Discord:", e));
  }
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "GET") return new Response("OK");
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
      const flags = await replyFlags(interaction, env);
      ctx.waitUntil(runCommand(handler, interaction, env));
      return json(
        flags ? { type: ResponseType.DEFERRED_CHANNEL_MESSAGE, data: { flags } } : { type: ResponseType.DEFERRED_CHANNEL_MESSAGE },
      );
    }

    return new Response("Unsupported interaction type", { status: 400 });
  },

  async scheduled(controller, env, ctx) {
    // Scheduled posts get their own 5-minute trigger, so their many requests
    // never compete with reminders and @mentions for the per-run limit.
    if (controller?.cron === SCHEDULED_POSTS_CRON) {
      ctx.waitUntil(runScheduledPosts(env));
      return;
    }
    ctx.waitUntil(postDueReminders(env));
    ctx.waitUntil(pollMentions(env).catch((err) => console.error("Checking for mentions failed:", err)));
    ctx.waitUntil(
      syncCommandsIfChanged(env).catch((err) => console.error("Syncing slash commands failed:", err)),
    );
  },
};
