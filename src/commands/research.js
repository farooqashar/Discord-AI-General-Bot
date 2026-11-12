import { callClaude } from "../claude.js";
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

// Keep research quick and cheap: each search costs extra, and the free
// Workers plan gives background work about 30 seconds.
const MAX_SEARCHES = 4;
const MAX_SOURCES = 8;

export async function research(interaction, env) {
  const question = getOption(interaction, "question");

  const placeholder = await editOriginal(env, interaction, {
    content: `🔎 Researching **${question}**…`,
    allowed_mentions: NO_MENTIONS,
  });

  // Start a thread on that message so the report doesn't flood the channel.
  // This fails inside existing threads or DMs; then we just reply in place.
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

  const { report, sources } = await runResearch(env, question);
  const text = formatReport(report, sources);

  for (const chunk of splitMessage(text)) {
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

async function runResearch(env, question) {
  const messages = [{ role: "user", content: question }];
  let response;

  // Long searches can come back as "pause_turn"; send the partial answer
  // back unchanged so Claude can continue where it left off.
  for (let round = 0; round < 3; round++) {
    response = await callClaude(env, {
      max_tokens: 2048,
      system: SYSTEM,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: MAX_SEARCHES }],
      messages,
    });
    if (response.stop_reason !== "pause_turn") break;
    messages.push({ role: "assistant", content: response.content });
  }

  const blocks = response.content;
  // Only keep the text written after the last search, which is the report itself.
  const lastSearch = blocks.findLastIndex((b) => b.type === "web_search_tool_result");
  const reportBlocks = blocks.slice(lastSearch + 1).filter((b) => b.type === "text");
  const report = reportBlocks.map((b) => b.text).join("").trim();

  // Prefer the sources Claude actually cited; fall back to raw search results.
  const sources = new Map();
  for (const block of reportBlocks) {
    for (const citation of block.citations ?? []) {
      if (citation.url && !sources.has(citation.url)) sources.set(citation.url, citation.title);
    }
  }
  if (sources.size === 0) {
    for (const block of blocks) {
      if (block.type !== "web_search_tool_result" || !Array.isArray(block.content)) continue;
      for (const result of block.content) {
        if (result.url && !sources.has(result.url)) sources.set(result.url, result.title);
      }
    }
  }

  return {
    report: report || "I couldn't put together an answer for that. Try rephrasing the question?",
    sources: [...sources].slice(0, MAX_SOURCES).map(([url, title]) => ({ url, title })),
  };
}

function formatReport(report, sources) {
  if (sources.length === 0) return report;
  const list = sources
    .map(({ url, title }, i) => {
      const label = (title || new URL(url).hostname).replace(/[[\]]/g, "").slice(0, 80);
      // <url> stops Discord from unfurling a big preview for every link.
      return `${i + 1}. [${label}](<${url}>)`;
    })
    .join("\n");
  return `${report}\n\n**Sources**\n${list}`;
}

function threadName(question) {
  const name = `Research: ${question}`;
  return name.length > 100 ? `${name.slice(0, 97)}…` : name;
}
