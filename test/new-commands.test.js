import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { summarize, validateUrl } from "../src/commands/summarize.js";
import { channelStats, vibeCheck } from "../src/commands/vibe-check.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function mockFetch({ claude, discord = () => ({ id: "1" }) }) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    url = String(url);
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, method: init.method ?? "GET", body });
    if (url.includes("anthropic")) return Response.json(claude(body));
    return Response.json(discord(url));
  };
  return calls;
}

const interaction = (name, options = [], extra = {}) => ({
  application_id: "app",
  token: "tok",
  channel_id: "chan",
  guild_id: "guild",
  data: { name, options, ...extra },
});
const lastEdit = (calls) => calls.filter((c) => c.url.endsWith("/messages/@original")).at(-1);

test("validates links for /summarize", () => {
  assert.equal(validateUrl("https://example.com/a"), "https://example.com/a");
  assert.equal(validateUrl("<https://example.com>"), "https://example.com/");
  assert.equal(validateUrl("example.com"), null);
  assert.equal(validateUrl("javascript:alert(1)"), null);
  assert.equal(validateUrl(`https://x.com/${"a".repeat(300)}`), null);
});

test("/summarize sends the link to Claude's web fetch tool and posts the summary", async () => {
  let request;
  const calls = mockFetch({
    claude: (body) => {
      request = body;
      return {
        stop_reason: "end_turn",
        content: [
          { type: "text", text: "Let me fetch that." },
          { type: "server_tool_use", id: "s1", name: "web_fetch", input: { url: "https://example.com/a" } },
          { type: "web_fetch_tool_result", tool_use_id: "s1", content: { type: "web_fetch_result", url: "https://example.com/a" } },
          { type: "text", text: "**Example**\nIt's an example page." },
        ],
      };
    },
  });
  await summarize(interaction("summarize", [{ name: "link", value: "https://example.com/a" }]), {});

  assert.equal(request.tools[0].type, "web_fetch_20250910");
  assert.match(request.messages[0].content, /https:\/\/example\.com\/a/);
  const content = lastEdit(calls).body.content;
  assert.match(content, /It's an example page/);
  assert.doesNotMatch(content, /Let me fetch/);
});

test("/summarize explains when a page can't be fetched", async () => {
  const calls = mockFetch({
    claude: () => ({
      stop_reason: "end_turn",
      content: [
        { type: "web_fetch_tool_result", tool_use_id: "s1", content: { type: "web_fetch_tool_result_error", error_code: "url_not_accessible" } },
        { type: "text", text: "I couldn't access it." },
      ],
    }),
  });
  await summarize(interaction("summarize", [{ name: "link", value: "https://example.com/private" }]), {});
  assert.match(lastEdit(calls).body.content, /couldn't summarize.*returned an error/);
});

const msg = (id, name, content, iso) => ({
  id,
  content,
  timestamp: iso,
  author: { id: name, username: name, bot: false },
});

test("computes exact channel stats", () => {
  const stats = channelStats(
    [
      msg("1", "ash", "hi", "2026-11-10T23:00:00Z"),
      msg("2", "ash", "yo", "2026-11-10T23:30:00Z"),
      msg("3", "sam", "hey", "2026-11-12T15:00:00Z"),
    ],
    "America/New_York",
  );
  assert.equal(stats.total, 3);
  assert.equal(stats.people, 2);
  assert.deepEqual(stats.top[0], ["ash", 2]);
  assert.equal(stats.busiestHour, 18); // 23:00 UTC is 6 PM in New York
});

test("/vibe-check pages through history, skips bots, and renders the meters", async () => {
  const page1 = Array.from({ length: 100 }, (_, i) =>
    msg(String(1000 - i), i % 2 ? "ash" : "sam", `message ${i}`, new Date(Date.UTC(2026, 10, 12, 12, 0, 0) - i * 60000).toISOString()),
  );
  page1[0].author.bot = true;
  const page2 = Array.from({ length: 20 }, (_, i) =>
    msg(String(800 - i), "jo", `older ${i}`, "2026-11-11T12:00:00Z"),
  );
  let prompt;
  const calls = mockFetch({
    claude: (body) => {
      prompt = body.messages[0].content;
      return {
        content: [
          {
            type: "tool_use",
            input: {
              headline: "Group chat running on caffeine",
              emoji: "☕",
              energy: 4,
              silliness: 5,
              positivity: 4,
              topics: ["food", "trains"],
              running_jokes: ["the LIRR"],
              verdict: "Chaotic good.",
            },
          },
        ],
      };
    },
    discord: (url) => (url.includes("before=") ? page2 : url.includes("/channels/chan/messages") ? page1 : { id: "m" }),
  });

  await vibeCheck(interaction("vibe-check", [{ name: "messages", value: 150 }]), {});

  const fetches = calls.filter((c) => c.url.includes("/channels/chan/messages"));
  assert.equal(fetches.length, 2);
  assert.match(fetches[1].url, /limit=50&before=901/);
  assert.match(prompt, /119 messages/); // 120 fetched, 1 bot message skipped
  const content = lastEdit(calls).body.content;
  assert.match(content, /☕ \*\*Vibe check: this channel\*\*/);
  assert.match(content, /sleepy   ●●●●○ chaotic/);
  assert.match(content, /\*\*Running bits:\*\* the LIRR/);
  assert.deepEqual(lastEdit(calls).body.allowed_mentions, { parse: [] });
});

test("/vibe-check refuses a channel the user can't read", async () => {
  const calls = mockFetch({ claude: () => assert.fail("no Claude call") });
  const i = interaction("vibe-check", [{ name: "channel", value: "secret" }], {
    resolved: { channels: { secret: { id: "secret", permissions: "0" } } },
  });
  await assert.rejects(vibeCheck(i, {}), /only vibe-check channels you can read/);
  assert.ok(!calls.some((c) => c.url.includes("/channels/secret/messages")));
});

test("users never see the AI provider or raw error details", async () => {
  const { default: worker } = await import("../src/index.js");
  const { COMMANDS } = await import("../src/command-definitions.js");
  const visible = JSON.stringify(COMMANDS);
  assert.doesNotMatch(visible, /claude|anthropic|haiku|sonnet|opus/i);

  // A failing API call shows only a generic message.
  const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const pub = Buffer.from(await crypto.subtle.exportKey("raw", keys.publicKey)).toString("hex");
  const body = JSON.stringify({
    type: 2,
    application_id: "app",
    token: "tok",
    channel_id: "chan",
    data: { name: "ask", options: [{ name: "question", value: "hi" }] },
  });
  const ts = "1";
  const sig = Buffer.from(
    await crypto.subtle.sign("Ed25519", keys.privateKey, new TextEncoder().encode(ts + body)),
  ).toString("hex");

  // Claude rejects the key; Discord calls are recorded.
  let systemPrompt;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    url = String(url);
    if (url.includes("anthropic")) {
      systemPrompt = JSON.parse(init.body).system;
      return new Response('{"error":{"message":"invalid x-api-key"}}', { status: 401 });
    }
    calls.push({ url, body: JSON.parse(init.body) });
    return Response.json({ id: "1" });
  };

  let background;
  const consoleError = console.error;
  console.error = () => {};
  try {
    await worker.fetch(
      new Request("https://bot.example/", {
        method: "POST",
        headers: { "X-Signature-Ed25519": sig, "X-Signature-Timestamp": ts },
        body,
      }),
      { DISCORD_PUBLIC_KEY: pub, BOT_NAME: "Ashistant" },
      { waitUntil: (p) => (background = p) },
    );
    await background;
  } finally {
    console.error = consoleError;
  }

  assert.match(systemPrompt, /^You are Ashistant/);
  assert.match(systemPrompt, /Don't mention which AI model or company/);
  const shown = lastEdit(calls).body.content;
  assert.equal(shown, "⚠️ Sorry, something went wrong. Please try again in a bit.");
});
