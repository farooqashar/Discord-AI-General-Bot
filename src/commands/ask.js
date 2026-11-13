import { callClaude, textOf } from "../claude.js";
import {
  authorName,
  channelLabel,
  discordApi,
  getOption,
  invokingUser,
  replyWithText,
  targetChannel,
} from "../discord.js";

const SYSTEM = `You answer questions inside a Discord server.
You're given the channel's recent messages for context, oldest first. Lines from "you" are your own
earlier replies. Use the chat when the question refers to it ("wdym?", "what did Sam say?",
"summarize the plan", "the second one"); otherwise just answer the question on its own.
Don't recap the chat unless asked, and never invent messages that aren't shown.
Keep answers short and conversational: usually a few sentences, at most a short list.
Use Discord markdown (bold, bullet lists, code blocks) only when it helps.
Never use @everyone or @here.`;

const CONTEXT_MESSAGES = 20;

/** The last few messages as "name: text" lines, oldest first, marking the bot's own replies. */
export function formatContext(messages, botId) {
  return messages
    .filter((m) => m.content?.trim())
    .reverse()
    .map((m) => {
      const who = m.author?.id === botId ? "you" : authorName(m);
      const asker = m.author?.id === botId && m.interaction_metadata?.user
        ? ` (replying to ${m.interaction_metadata.user.global_name ?? m.interaction_metadata.user.username})`
        : "";
      return `${who}${asker}: ${m.content.slice(0, 500)}`;
    })
    .join("\n");
}

export async function ask(interaction, env) {
  const question = getOption(interaction, "question");
  const channelId = targetChannel(interaction, "ask about");
  const asker = invokingUser(interaction);
  const askerName = interaction.member?.nick ?? asker?.global_name ?? asker?.username ?? "someone";

  // Recent chat lets follow-ups like "wdym?" work. If the bot can't read the
  // channel, answer without it rather than failing.
  let context = "";
  try {
    const recent = await discordApi(env, `/channels/${channelId}/messages?limit=${CONTEXT_MESSAGES}`);
    context = formatContext(recent, interaction.application_id);
  } catch (err) {
    console.warn("Couldn't read recent messages for /ask:", err.message);
  }

  const where = channelId === interaction.channel_id ? "this channel" : "the channel they asked about";
  const prompt = context
    ? `Recent messages in ${where}:\n${context}\n\nQuestion from ${askerName}: ${question}`
    : `Question from ${askerName}: ${question}`;

  const message = await callClaude(env, {
    max_tokens: 1024,
    system: SYSTEM,
    messages: [{ role: "user", content: prompt }],
  });
  const answer = textOf(message) || "I didn't get an answer back. Try rephrasing?";

  const quoted = question.length > 300 ? `${question.slice(0, 300)}…` : question;
  await replyWithText(env, interaction, `> ${quoted}${channelLabel(interaction, channelId)}\n\n${answer}`);
}
