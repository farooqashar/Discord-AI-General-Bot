import { callClaude, textOf } from "../claude.js";
import {
  authorName,
  channelLabel,
  fetchHistory,
  getOption,
  replyWithText,
  targetChannel,
} from "../discord.js";

const CHANNEL_SYSTEM = `You summarize Discord conversations for people catching up.
Explain what the chat was about in 1–2 plain, casual sentences (under 50 words).
No bullet points, headings, lists or intro. Mention people by the names shown only when it helps.
Never use @everyone or @here.`;

const PERSON_SYSTEM = `You summarize what one person has been saying in a Discord channel.
In 1–2 plain, casual sentences (under 50 words), say what they've been talking about and their
general take or mood. Stick to what their messages show; don't guess at anything private.
No bullet points, headings, lists or intro. Never use @everyone or @here.`;

// How far back to look for one person's messages.
const PERSON_SCAN_LIMIT = 500;

function toLine(m) {
  const time = m.timestamp.slice(11, 16);
  const files = m.attachments?.length ? ` [${m.attachments.length} attachment(s)]` : "";
  return `[${time} UTC] ${authorName(m)}: ${m.content}${files}`;
}

export async function tldr(interaction, env) {
  const channelId = targetChannel(interaction, "summarize");
  const count = getOption(interaction, "messages") ?? 50;
  const userId = getOption(interaction, "user");
  const where = channelLabel(interaction, channelId);

  const hasText = (m) => m.content?.trim() || m.attachments?.length;
  let picked;
  if (userId) {
    // One person's messages are spread out, so look further back and keep
    // their most recent ones.
    const history = await fetchHistory(env, channelId, PERSON_SCAN_LIMIT);
    picked = history.filter((m) => m.author?.id === userId && hasText(m)).slice(0, count);
  } else {
    picked = (await fetchHistory(env, channelId, count)).filter(hasText);
  }
  // Newest first from Discord; flip it so the transcript reads in order.
  const lines = picked.reverse().map(toLine);

  if (lines.length === 0) {
    const empty = userId
      ? `<@${userId}> hasn't said anything${where || " here"} in the last ${PERSON_SCAN_LIMIT} messages.`
      : `There's nothing${where || " here"} to summarize yet.`;
    await replyWithText(env, interaction, empty);
    return;
  }

  const name = userId ? authorName(picked[0]) : null;
  const message = await callClaude(env, {
    max_tokens: 800,
    system: userId ? PERSON_SYSTEM : CHANNEL_SYSTEM,
    messages: [
      {
        role: "user",
        content: userId
          ? `Summarize what ${name} has been saying (${lines.length} of their messages):\n\n${lines.join("\n")}`
          : `Summarize this conversation (${lines.length} messages):\n\n${lines.join("\n")}`,
      },
    ],
  });

  // The mention shows their name but doesn't ping them (replies never ping).
  const header = userId
    ? `📝 **TL;DR of <@${userId}>**${where} (${lines.length} messages)`
    : `📝 **TL;DR**${where} (${lines.length} messages)`;
  await replyWithText(env, interaction, `${header}\n${textOf(message)}`);
}
