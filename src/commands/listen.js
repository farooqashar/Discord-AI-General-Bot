// @mention replies without a live connection to Discord.
//
// Slash commands arrive as web requests, but ordinary messages only reach a
// bot that stays connected. Instead, the every-minute cron checks the channels
// turned on with /listen for new messages that @mention the bot (or reply to
// one of its messages) and answers them. Replies take up to about a minute.

import { capabilities, formatSources, webSearch } from "../claude.js";
import {
  NO_MENTIONS,
  UserFacingError,
  canManageChannels,
  discordApi,
  editOriginal,
  getOption,
  sendChannelMessage,
  splitMessage,
} from "../discord.js";
import { formatContext } from "./ask.js";


// Keeps a burst of mentions from running up the bill or spamming the channel.
const MAX_REPLIES_PER_CHANNEL_PER_RUN = 5;
const CONTEXT_MESSAGES = 20;

const SYSTEM = `You're chatting in a Discord channel. Someone just mentioned you or replied to you.
You're given the recent chat for context, oldest first; lines from "you" are your own earlier messages.
Reply to their latest message naturally, like a friend in the group chat: usually 1–3 sentences,
longer only if they asked for detail. Use the chat when they refer to it. Don't recap the chat,
don't greet them by name every time, and never invent messages that aren't shown.
Never use @everyone or @here.`;

async function ensureTable(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS watched_channels (
       channel_id TEXT PRIMARY KEY,
       guild_id TEXT,
       last_seen_id TEXT,
       added_by TEXT,
       created_at INTEGER NOT NULL DEFAULT (unixepoch())
     )`,
  ).run();
}


/** /listen on | off | status */
export async function listen(interaction, env) {
  const action = getOption(interaction, "action") ?? "status";
  const channelId = interaction.channel_id;
  await ensureTable(env);

  if (action !== "status" && !canManageChannels(interaction)) {
    throw new UserFacingError("🔒 Only people who can manage channels can turn listening on or off.");
  }

  let content;
  if (action === "on") {
    // Start from the newest message so the bot never answers old mentions.
    const latest = await discordApi(env, `/channels/${channelId}/messages?limit=1`);
    await env.DB.prepare(
      `INSERT INTO watched_channels (channel_id, guild_id, last_seen_id, added_by) VALUES (?, ?, ?, ?)
       ON CONFLICT(channel_id) DO UPDATE SET last_seen_id = excluded.last_seen_id`,
    )
      .bind(channelId, interaction.guild_id ?? null, latest[0]?.id ?? "0", interaction.member?.user?.id ?? null)
      .run();
    content = "👂 I'm listening here now. @mention me (or reply to one of my messages) and I'll answer within about a minute.";
  } else if (action === "off") {
    await env.DB.prepare("DELETE FROM watched_channels WHERE channel_id = ?").bind(channelId).run();
    content = "🙉 I've stopped listening here. Slash commands still work.";
  } else {
    const { results } = await env.DB.prepare(
      "SELECT channel_id FROM watched_channels WHERE guild_id = ? OR channel_id = ?",
    )
      .bind(interaction.guild_id ?? "", channelId)
      .all();
    content = results.length
      ? `👂 I answer @mentions in: ${results.map((r) => `<#${r.channel_id}>`).join(", ")}`
      : "🙉 I'm not listening in any channels yet. An admin can run `/listen on` in a channel to start.";
  }
  await editOriginal(env, interaction, { content, allowed_mentions: NO_MENTIONS });
}

/** Does this message @mention the bot, or reply to one of its messages? */
export function isForBot(message, botId) {
  if (!message || message.author?.bot) return false;
  const mentioned =
    message.mentions?.some((u) => u.id === botId) ||
    message.content?.includes(`<@${botId}>`) ||
    message.content?.includes(`<@!${botId}>`);
  const repliedToBot = message.referenced_message?.author?.id === botId;
  return Boolean(mentioned || repliedToBot);
}

/** Snowflake IDs grow over time; compare them as big integers. */
const newer = (a, b) => (BigInt(a) > BigInt(b) ? 1 : -1);

async function answer(env, channelId, message, botId) {
  // Show "Ashistant is typing…" while the answer is written.
  await discordApi(env, `/channels/${channelId}/typing`, { method: "POST" }).catch(() => {});

  const earlier = await discordApi(env, `/channels/${channelId}/messages?limit=${CONTEXT_MESSAGES}&before=${message.id}`);
  const context = formatContext(earlier, botId);
  const name = message.member?.nick ?? message.author.global_name ?? message.author.username;
  const text = message.content.replaceAll(`<@${botId}>`, "").replaceAll(`<@!${botId}>`, "").trim() || "(just mentioned you)";

  const { text: replyText, sources } = await webSearch(env, {
    system: `${SYSTEM}\n\n${capabilities()}`,
    prompt: `${context ? `Recent chat:\n${context}\n\n` : ""}Latest message, from ${name}: ${text}`,
    maxSearches: 2,
  });
  const sourceList = formatSources(sources, 3);
  const chunks = splitMessage(
    (replyText || "🤔 I'm not sure what to say to that.") + (sourceList ? `\n\n${sourceList}` : ""),
  );

  for (const [i, chunk] of chunks.entries()) {
    await sendChannelMessage(env, channelId, {
      content: chunk,
      // The first part is a proper reply to their message and notifies them;
      // nothing else in the text can ping anyone.
      ...(i === 0 ? { message_reference: { message_id: message.id, fail_if_not_exists: false } } : {}),
      allowed_mentions: { parse: [], replied_user: i === 0 },
    });
  }
}

/** Runs every minute from the cron trigger. */
export async function pollMentions(env) {
  if (!env.DB || !env.DISCORD_APP_ID) return;
  await ensureTable(env);
  const botId = env.DISCORD_APP_ID;
  const { results: channels } = await env.DB.prepare("SELECT channel_id, last_seen_id FROM watched_channels").all();

  for (const { channel_id: channelId, last_seen_id: lastSeen } of channels) {
    try {
      const fresh = await discordApi(env, `/channels/${channelId}/messages?limit=50&after=${lastSeen || "0"}`);
      if (!fresh.length) continue;
      const ordered = [...fresh].sort((a, b) => newer(a.id, b.id)); // oldest first

      // Claim these messages before answering, so a slow run can't overlap
      // with the next one and answer twice.
      const newest = ordered[ordered.length - 1].id;
      await env.DB.prepare("UPDATE watched_channels SET last_seen_id = ? WHERE channel_id = ?").bind(newest, channelId).run();

      const forBot = ordered.filter((m) => isForBot(m, botId)).slice(-MAX_REPLIES_PER_CHANNEL_PER_RUN);
      for (const message of forBot) {
        await answer(env, channelId, message, botId).catch((err) =>
          console.error(`Couldn't answer message ${message.id} in ${channelId}:`, err),
        );
      }
    } catch (err) {
      // A deleted channel or missing permission: stop watching it.
      if (err.status === 403 || err.status === 404) {
        console.warn(`Stopped listening in ${channelId} (${err.status})`);
        await env.DB.prepare("DELETE FROM watched_channels WHERE channel_id = ?").bind(channelId).run();
      } else {
        console.error(`Checking ${channelId} for mentions failed:`, err);
      }
    }
  }
}
