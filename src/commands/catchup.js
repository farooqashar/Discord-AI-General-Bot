// /catchup: what happened in a channel since your last message, plus anything
// that mentions, replies to, or asks you something. Private by default; the
// reply privacy itself is decided in index.js before the deferred reply.

import { extractStructured } from "../claude.js";
import {
  NO_MENTIONS,
  authorName,
  channelLabel,
  discordTimestamp,
  editOriginal,
  fetchHistory,
  invokingUser,
  targetChannel,
} from "../discord.js";

const SCAN_MESSAGES = 300;
const FALLBACK_MS = 24 * 60 * 60 * 1000;
const MAX_FOR_YOU = 5;

const SCHEMA = {
  type: "object",
  properties: {
    summary: {
      type: "string",
      description: "1–2 casual sentences (under 45 words) on what happened, including any decisions or plans",
    },
    for_you: {
      type: "array",
      items: { type: "integer" },
      maxItems: MAX_FOR_YOU,
      description: "Indexes of messages that ask the reader something, need their answer, or are clearly aimed at them",
    },
  },
  required: ["summary", "for_you"],
};

const short = (text, n) => {
  const t = (text || "(attachment)").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** Is this message clearly for the user: an @mention or a reply to them? */
export function isForUser(message, userId) {
  return (
    message.mentions?.some((u) => u.id === userId) ||
    message.content?.includes(`<@${userId}>`) ||
    message.content?.includes(`<@!${userId}>`) ||
    message.referenced_message?.author?.id === userId
  );
}

/**
 * The messages to catch up on, oldest first: everything after the user's last
 * message, or the last 24 hours if they haven't posted recently.
 */
export function messagesSince(history, userId, now = Date.now()) {
  const lastOwn = history.findIndex((m) => m.author?.id === userId); // history is newest first
  const fresh = lastOwn >= 0 ? history.slice(0, lastOwn) : history.filter((m) => now - new Date(m.timestamp) <= FALLBACK_MS);
  return {
    messages: fresh.filter((m) => m.author?.id !== userId).reverse(),
    since: lastOwn >= 0 ? new Date(history[lastOwn].timestamp) : new Date(now - FALLBACK_MS),
    sinceOwnMessage: lastOwn >= 0,
  };
}

export async function catchup(interaction, env) {
  const channelId = targetChannel(interaction, "catch up on");
  const user = invokingUser(interaction);
  const readerName = interaction.member?.nick ?? user?.global_name ?? user?.username ?? "you";
  const where = channelLabel(interaction, channelId).replace(/^ in /, "") || "this channel";
  const reply = (content) => editOriginal(env, interaction, { content: content.slice(0, 1990), allowed_mentions: NO_MENTIONS });

  const history = await fetchHistory(env, channelId, SCAN_MESSAGES);
  const { messages, since, sinceOwnMessage } = messagesSince(history, user.id);
  const sinceText = sinceOwnMessage ? `since your last message ${discordTimestamp(since, "R")}` : "in the last 24 hours";

  const humans = messages.filter((m) => !m.author?.bot);
  if (!humans.length) {
    await reply(`🧭 You're all caught up in ${where}: nothing new ${sinceText}.`);
    return;
  }

  const lines = messages.map((m, i) => `${i}: ${authorName(m)}${m.author?.bot ? " (bot)" : ""}: ${short(m.content, 300)}`);
  let pick = { summary: "", for_you: [] };
  try {
    pick = await extractStructured(env, {
      system:
        `You help ${readerName} catch up on a Discord channel they were away from. ` +
        "Summarize what happened for them and point out messages they should answer or look at. " +
        "Only flag messages clearly aimed at them or at everyone (e.g. \"who's coming?\"); don't flag ordinary chatter.",
      prompt: `Messages since ${readerName} was last here, oldest first (index: author: text):\n${lines.join("\n")}`,
      toolName: "catch_up",
      description: "Catch the reader up",
      schema: SCHEMA,
    });
  } catch (err) {
    console.warn("Catch-up AI step failed:", err.message);
  }

  // Definite mentions and replies always count; the AI adds questions for them.
  const forYou = new Set(messages.map((m, i) => (isForUser(m, user.id) ? i : -1)).filter((i) => i >= 0));
  for (const i of pick.for_you ?? []) if (Number.isInteger(i) && messages[i]) forYou.add(i);
  const flagged = [...forYou].sort((a, b) => a - b).slice(-MAX_FOR_YOU);

  const link = (m) => `https://discord.com/channels/${interaction.guild_id ?? "@me"}/${channelId}/${m.id}`;
  const out = [
    `🧭 **Catch-up** · ${where} · ${humans.length} message${humans.length === 1 ? "" : "s"} ${sinceText}`,
    pick.summary?.trim() || "Lots of chatter; here's what's for you.",
  ];
  if (flagged.length) {
    out.push("", "**For you:**");
    for (const i of flagged) out.push(`• ${authorName(messages[i])}: "${short(messages[i].content, 80)}" ${link(messages[i])}`);
  }
  await reply(out.join("\n"));
}
