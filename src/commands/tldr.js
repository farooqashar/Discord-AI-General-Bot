import { callClaude, textOf } from "../claude.js";
import { discordApi, getOption, replyWithText } from "../discord.js";

const SYSTEM = `You summarize Discord conversations for people catching up.
Write a short summary in Discord markdown, under 200 words:
- a one-line overview
- bullet points for the main topics, with who said what when it matters
- any decisions made, and any open questions or to-dos
Refer to people by the names shown. Never use @everyone or @here.`;

export async function tldr(interaction, env) {
  const count = getOption(interaction, "messages") ?? 50;

  // Newest first from Discord; we flip it so the transcript reads in order.
  const messages = await discordApi(env, `/channels/${interaction.channel_id}/messages?limit=${count}`);
  const lines = messages
    .reverse()
    .filter((m) => m.content?.trim() || m.attachments?.length)
    .map((m) => {
      const name = m.member?.nick ?? m.author.global_name ?? m.author.username;
      const time = m.timestamp.slice(11, 16);
      const files = m.attachments?.length ? ` [${m.attachments.length} attachment(s)]` : "";
      return `[${time} UTC] ${name}: ${m.content}${files}`;
    });

  if (lines.length === 0) {
    await replyWithText(env, interaction, "There's nothing here to summarize yet.");
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
    `📝 **TL;DR of the last ${lines.length} messages**\n\n${textOf(message)}`,
  );
}
