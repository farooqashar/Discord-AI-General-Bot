// Small wrapper around the Anthropic Messages API.

const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";
export const DEFAULT_MODEL = "claude-haiku-5-5";

/** Prepended to every prompt so replies never reveal the model or company behind the bot. */
export function persona(env) {
  const name = env.BOT_NAME || "Ashistant";
  return `You are ${name}, an AI assistant in a Discord server. Don't mention which AI model or company powers you, and don't call yourself by any other name. If someone asks what you are or who made you, just say you're ${name}, a bot for this server.`;
}

export async function callClaude(env, body) {
  body = { ...body, system: body.system ? `${persona(env)}\n\n${body.system}` : persona(env) };
  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": API_VERSION,
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: env.CLAUDE_MODEL || DEFAULT_MODEL, ...body }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`AI request failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return res.json();
}

/** Join the text blocks of a Claude response. */
export function textOf(message) {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

/**
 * Have Claude fill in a structured form instead of writing prose.
 * We force a single "tool" call and read its input back as plain JSON,
 * which is far more reliable than asking for JSON in the text.
 */
export async function extractStructured(env, { system, prompt, toolName, description, schema }) {
  const message = await callClaude(env, {
    max_tokens: 1024,
    system,
    messages: [{ role: "user", content: prompt }],
    tools: [{ name: toolName, description, input_schema: schema }],
    tool_choice: { type: "tool", name: toolName },
  });
  const call = message.content.find((block) => block.type === "tool_use");
  if (!call) throw new Error("AI response was missing structured details");
  return call.input;
}

/** A sentence telling Claude what "now" is, so it can resolve "tomorrow at 6". */
export function describeNow(timeZone) {
  const now = new Date();
  const local = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "longOffset",
  }).format(now);
  return `It is currently ${local} in the ${timeZone} time zone (UTC: ${now.toISOString()}).`;
}

/**
 * Ask Claude to search the web and write an answer.
 * Returns the final text (written after the last search) and the sources it cited.
 */
export async function webSearch(env, { system, prompt, maxSearches = 4, maxTokens = 2048, location }) {
  const tool = { type: "web_search_20250305", name: "web_search", max_uses: maxSearches };
  if (location) tool.user_location = { type: "approximate", ...location };

  const messages = [{ role: "user", content: prompt }];
  let response;
  // Long searches can come back as "pause_turn"; send the partial answer
  // back unchanged so Claude can continue where it left off.
  for (let round = 0; round < 3; round++) {
    response = await callClaude(env, { max_tokens: maxTokens, system, tools: [tool], messages });
    if (response.stop_reason !== "pause_turn") break;
    messages.push({ role: "assistant", content: response.content });
  }

  const blocks = response.content;
  // Only keep the text written after the last search, which is the answer itself.
  const lastSearch = blocks.findLastIndex((b) => b.type === "web_search_tool_result");
  const answerBlocks = blocks.slice(lastSearch + 1).filter((b) => b.type === "text");
  const text = answerBlocks.map((b) => b.text).join("").trim();

  // Prefer the sources Claude actually cited; fall back to raw search results.
  const sources = new Map();
  for (const block of answerBlocks) {
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

  return { text, sources: [...sources].map(([url, title]) => ({ url, title })) };
}

/** A numbered list of source links that Discord won't unfurl into big previews. */
export function formatSources(sources, max = 8) {
  if (!sources.length) return "";
  const list = sources
    .slice(0, max)
    .map(({ url, title }, i) => {
      let label = title;
      if (!label) {
        try {
          label = new URL(url).hostname;
        } catch {
          label = url;
        }
      }
      label = label.replace(/[[\]]/g, "").slice(0, 80);
      return `${i + 1}. [${label}](<${url}>)`;
    })
    .join("\n");
  return `**Sources**\n${list}`;
}
