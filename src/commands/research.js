import { formatSources, webSearch } from "../claude.js";
import {
  NO_MENTIONS,
  discordApi,
  editOriginal,
  followUp,
  getOption,
  sendChannelMessage,
  splitMessage,
} from "../discord.js";

const SYSTEM = `You are a research assistant inside a Discord server.
Search the web, then write a concise report in Discord markdown, under 350 words:
- start with a 1–2 sentence direct answer
- then 3–6 bullet points with the key findings, including specific facts and numbers
- note anything uncertain or disputed
Don't narrate your searching. Don't include URLs or a sources list; sources are added automatically.
Never use @everyone or @here.`;

export async function research(interaction, env) {
  const question = getOption(interaction, "question");

  const placeholder = await editOriginal(env, interaction, {
    content: `🔎 Researching **${question}**…`,
    allowed_mentions: NO_MENTIONS,
  });

  // Start a thread on that message so the report doesn't flood the channel.
  // This fails inside existing threads; then we just reply in place.
  let threadId = null;
  try {
    const thread = await discordApi(
      env,
      `/channels/${interaction.channel_id}/messages/${placeholder.id}/threads`,
      { method: "POST", body: { name: threadName(question), auto_archive_duration: 1440 } },
    );
    threadId = thread.id;
  } catch (err) {
    console.warn("Couldn't create a thread; replying inline:", err.message);
  }

  // Capped at 4 searches: each one costs extra, and background work on the
  // free Workers plan gets about 30 seconds.
  const { text, sources } = await webSearch(env, { system: SYSTEM, prompt: question, maxSearches: 4 });
  const report = text || "I couldn't put together an answer for that. Try rephrasing the question?";
  const sourceList = formatSources(sources);
  const full = sourceList ? `${report}\n\n${sourceList}` : report;

  for (const chunk of splitMessage(full)) {
    const data = { content: chunk, allowed_mentions: NO_MENTIONS };
    if (threadId) await sendChannelMessage(env, threadId, data);
    else await followUp(env, interaction, data);
  }

  await editOriginal(env, interaction, {
    content: threadId
      ? `🔎 Research on **${question}** is ready in the thread below 👇`
      : `🔎 Research on **${question}**:`,
    allowed_mentions: NO_MENTIONS,
  });
}

function threadName(question) {
  const name = `Research: ${question}`;
  return name.length > 100 ? `${name.slice(0, 97)}…` : name;
}
