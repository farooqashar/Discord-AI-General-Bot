import { callClaude } from "../claude.js";
import { getOption, replyWithText } from "../discord.js";

const SYSTEM = `You summarize web pages for a Discord group chat.
Fetch the link, then reply in Discord markdown, under 200 words:
**<page title>**
one-sentence gist
3–5 short bullet points with the key points, including specific facts or numbers
**Worth reading?** one short, honest line
Don't narrate fetching the page. Never use @everyone or @here.`;

const FETCH_ERRORS = {
  url_not_accessible: "the site returned an error (it may be down, private, or blocking bots)",
  url_not_allowed: "that site can't be fetched (it blocks automated access)",
  unsupported_content_type: "it isn't a web page or PDF (videos and images can't be read)",
  content_too_large: "the document is too large",
  too_many_requests: "too many requests right now; try again in a minute",
  url_too_long: "the link is too long",
  invalid_tool_input: "that doesn't look like a valid link",
};

export function validateUrl(text) {
  const trimmed = text.trim().replace(/^<|>$/g, "");
  if (trimmed.length > 250) return null;
  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export async function summarize(interaction, env) {
  const url = validateUrl(getOption(interaction, "link"));
  if (!url) {
    await replyWithText(env, interaction, "🤔 That doesn't look like a link. Paste a full URL starting with `https://`.");
    return;
  }

  const messages = [{ role: "user", content: `Summarize this page: ${url}` }];
  let response;
  for (let round = 0; round < 3; round++) {
    response = await callClaude(env, {
      max_tokens: 1024,
      system: SYSTEM,
      tools: [
        // Capped so a huge page can't run up the bill.
        { type: "web_fetch_20250910", name: "web_fetch", max_uses: 2, max_content_tokens: 25000 },
      ],
      messages,
    });
    if (response.stop_reason !== "pause_turn") break;
    messages.push({ role: "assistant", content: response.content });
  }

  const blocks = response.content;
  const results = blocks.filter((b) => b.type === "web_fetch_tool_result");
  const succeeded = results.some((r) => r.content?.type === "web_fetch_result");
  const error = results.map((r) => r.content?.error_code).find(Boolean);

  if (!succeeded) {
    const reason = FETCH_ERRORS[error] ?? "the page couldn't be read";
    await replyWithText(env, interaction, `😕 I couldn't summarize <${url}>: ${reason}.`);
    return;
  }

  const lastFetch = blocks.findLastIndex((b) => b.type === "web_fetch_tool_result");
  const summary = blocks
    .slice(lastFetch + 1)
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

  // <url> stops Discord from adding a big link preview under the summary.
  await replyWithText(env, interaction, `🔗 <${url}>\n\n${summary || "The page was empty."}`);
}
