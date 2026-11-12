// Small wrapper around the Anthropic Messages API.

const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";
export const DEFAULT_MODEL = "claude-haiku-5-5";

export async function callClaude(env, body) {
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
    throw new Error(`Claude API error (${res.status}): ${text.slice(0, 300)}`);
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
  if (!call) throw new Error("Claude didn't return structured details");
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
