import { callClaude, textOf } from "../claude.js";
import { authorName, channelLabel, discordApi, getOption, replyWithText, targetChannel } from "../discord.js";

const SYSTEM = `You summarize Discord conversations for people catching up.
Explain what the chat was about in 1–2 plain, casual sentences (under 50 words).
No bullet points, headings, lists or intro. Mention people by the names shown only when it helps.
Never use @everyone or @here.`;

export async function tldr(interaction, env) {
  const channelId = targetChannel(interaction, "summarize");
  const count = getOption(interaction, "messages") ?? 50;

  // Newest first from Discord; we flip it so the transcript reads in order.
  const messages = await discordApi(env, `/channels/${channelId}/messages?limit=${count}`);
  const lines = messages
    .reverse()
    .filter((m) => m.content?.trim() || m.attachments?.length)
    .map((m) => {
      const name = authorName(m);
      const time = m.timestamp.slice(11, 16);
      const files = m.attachments?.length ? ` [${m.attachments.length} attachment(s)]` : "";
      return `[${time} UTC] ${name}: ${m.content}${files}`;
    });

  if (lines.length === 0) {
    await replyWithText(env, interaction, `There's nothing${channelLabel(interaction, channelId) || " here"} to summarize yet.`);
    return;
  }

  const message = await callClaude(env, {
    max_tokens: 800,
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: `Summarize this conversation (${lines.length} messages):\n\n${lines.join("\n")}`,
      },
    ],
  });

  await replyWithText(
    env,
    interaction,
    `📝 **TL;DR**${channelLabel(interaction, channelId)} (${lines.length} messages)\n${textOf(message)}`,
  );
}
