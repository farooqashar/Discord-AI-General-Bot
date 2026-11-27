import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { AiTimeoutError, webSearch } from "../src/claude.js";
import { postDueBirthdays } from "../src/commands/birthday.js";
import { summarize } from "../src/commands/summarize.js";
import worker, { errorRef } from "../src/index.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// Like a real fetch that never gets an answer: it only ends when aborted.
const hang = (_url, init) =>
  new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal.reason)));

function mock(anthropic) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    url = String(url);
    calls.push({ url, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : undefined });
    if (url.includes("anthropic")) return anthropic(url, init);
    if (url.includes("/messages?")) return Response.json([]);
    return Response.json({ id: "1" });
  };
  return calls;
}

async function signedRequest(payload) {
  const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const publicKeyHex = Buffer.from(await crypto.subtle.exportKey("raw", keys.publicKey)).toString("hex");
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const sig = await crypto.subtle.sign("Ed25519", keys.privateKey, new TextEncoder().encode(timestamp + body));
  const request = new Request("https://bot.example/", {
    method: "POST",
    headers: { "X-Signature-Ed25519": Buffer.from(sig).toString("hex"), "X-Signature-Timestamp": timestamp },
    body,
  });
  return { request, publicKeyHex };
}

test("a slash command whose AI call never answers ends in a friendly timeout message", async () => {
  const calls = mock(hang);
  const { request, publicKeyHex } = await signedRequest({
    type: 2,
    application_id: "app",
    token: "tok",
    channel_id: "chan",
    data: { name: "ask", options: [{ name: "question", value: "Capital of France?" }] },
  });
  // A short deadline stands in for the real 25-second budget.
  const env = { DISCORD_PUBLIC_KEY: publicKeyHex, ANTHROPIC_API_KEY: "test", DISCORD_TOKEN: "test", aiDeadline: Date.now() + 50 };
  let background;
  const realError = console.error;
  console.error = () => {};
  try {
    const res = await worker.fetch(request, env, { waitUntil: (p) => (background = p) });
    assert.deepEqual(await res.json(), { type: 5 });
    await background;
  } finally {
    console.error = realError;
  }
  const edit = calls.filter((c) => c.url.endsWith("/webhooks/app/tok/messages/@original")).at(-1);
  assert.ok(edit, "should edit the thinking reply");
  assert.equal(edit.body.content, "⏱️ That took too long. Try a shorter question or try again in a bit. (ref: ai-timeout)");
  assert.deepEqual(edit.body.allowed_mentions, { parse: [] });
});

test("pause_turn rounds share one deadline instead of each getting their own", async () => {
  let rounds = 0;
  const slowPause = async () => {
    rounds++;
    await new Promise((r) => setTimeout(r, 40));
    return Response.json({ content: [{ type: "text", text: "…" }], stop_reason: "pause_turn" });
  };
  mock(slowPause);
  // Each call alone fits in 80ms; three in a row don't.
  await assert.rejects(webSearch({ aiTimeoutMs: 80 }, { prompt: "q" }), AiTimeoutError);
  assert.ok(rounds < 3, `stopped after ${rounds} rounds`);

  rounds = 0;
  mock(slowPause);
  const interaction = { application_id: "app", token: "tok", data: { name: "summarize", options: [{ name: "link", value: "https://example.com" }] } };
  await assert.rejects(summarize(interaction, { aiTimeoutMs: 80 }), AiTimeoutError);
  assert.ok(rounds < 3, `stopped after ${rounds} rounds`);
});

test("a hung AI call in the cron is logged and the run carries on", async () => {
  const settings = [{ guild_id: "g", channel_id: "party", hour: 9, minute: 0, last_sent: null }];
  const people = [{ guild_id: "g", user_id: "sunny", name: "Sunny", month: 11, day: 17 }];
  const stmt = (sql) => ({
    run: async () => ({ meta: { changes: 1 } }),
    all: async () => ({ results: sql.includes("birthday_settings") ? settings : people }),
  });
  const db = { prepare: (sql) => ({ ...stmt(sql), bind: () => stmt(sql) }) };
  const calls = mock(hang);
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    const now = { date: "2026-11-17", day: 17, weekday: 2, minutes: 9 * 60 + 3 };
    assert.equal(await postDueBirthdays({ DB: db, aiTimeoutMs: 50 }, { now }), 1);
  } finally {
    console.warn = realWarn;
  }
  assert.ok(warnings.some((w) => /timed out/.test(w)), "the timeout is logged");
  const post = calls.find((c) => c.method === "POST" && c.url.endsWith("/channels/party/messages"));
  assert.equal(post.body.content, "🎂 Happy birthday <@sunny>! Hope it's a great one! 🎉");
});

test("timeouts get their own error code", () => {
  assert.equal(errorRef(new AiTimeoutError("AI request timed out after 25000ms")), "ai-timeout");
});
