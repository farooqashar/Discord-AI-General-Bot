import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../src/index.js";
import { splitMessage, verifyDiscordRequest } from "../src/discord.js";

const toHex = (buf) => Buffer.from(buf).toString("hex");

async function makeKeys() {
  const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const publicKeyHex = toHex(await crypto.subtle.exportKey("raw", keys.publicKey));
  return { privateKey: keys.privateKey, publicKeyHex };
}

async function signedRequest(privateKey, payload) {
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const sig = await crypto.subtle.sign("Ed25519", privateKey, new TextEncoder().encode(timestamp + body));
  return new Request("https://bot.example/", {
    method: "POST",
    headers: { "X-Signature-Ed25519": toHex(sig), "X-Signature-Timestamp": timestamp },
    body,
  });
}

test("accepts a correctly signed request and rejects a tampered one", async () => {
  const { privateKey, publicKeyHex } = await makeKeys();
  const good = await signedRequest(privateKey, { type: 1 });
  assert.equal((await verifyDiscordRequest(good, publicKeyHex)).valid, true);

  const tampered = await signedRequest(privateKey, { type: 1 });
  const forged = new Request(tampered.url, {
    method: "POST",
    headers: tampered.headers,
    body: JSON.stringify({ type: 2 }),
  });
  assert.equal((await verifyDiscordRequest(forged, publicKeyHex)).valid, false);
});

test("answers Discord's PING, registers the commands, and rejects unsigned requests", async () => {
  const { privateKey, publicKeyHex } = await makeKeys();
  const env = { DISCORD_PUBLIC_KEY: publicKeyHex, DISCORD_TOKEN: "bot-token" };
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return Response.json(JSON.parse(init.body));
  };

  try {
    let background;
    const ctx = { waitUntil: (p) => (background = p) };
    const ping = { type: 1, application_id: "app123" };
    const res = await worker.fetch(await signedRequest(privateKey, ping), env, ctx);
    assert.deepEqual(await res.json(), { type: 1 });
    await background;

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://discord.com/api/v10/applications/app123/commands");
    assert.equal(calls[0].init.method, "PUT");
    assert.equal(calls[0].init.headers.Authorization, "Bot bot-token");
    const names = JSON.parse(calls[0].init.body).map((c) => c.name);
    assert.deepEqual(names.slice(0, 5), ["ask", "tldr", "event", "remind", "research"]);
    assert.equal(names.length, 13);

    const unsigned = new Request("https://bot.example/", { method: "POST", body: "{}" });
    assert.equal((await worker.fetch(unsigned, env, ctx)).status, 401);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("defers a slash command and edits the reply with Claude's answer", async () => {
  const { privateKey, publicKeyHex } = await makeKeys();
  const env = { DISCORD_PUBLIC_KEY: publicKeyHex, ANTHROPIC_API_KEY: "test", DISCORD_TOKEN: "test" };
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).includes("anthropic")) {
      return Response.json({ content: [{ type: "text", text: "Paris." }], stop_reason: "end_turn" });
    }
    return Response.json({ id: "1" });
  };

  try {
    let background;
    const ctx = { waitUntil: (p) => (background = p) };
    const interaction = {
      type: 2,
      application_id: "app",
      token: "tok",
      channel_id: "chan",
      data: { name: "ask", options: [{ name: "question", value: "Capital of France?" }] },
    };
    const res = await worker.fetch(await signedRequest(privateKey, interaction), env, ctx);
    assert.deepEqual(await res.json(), { type: 5 });
    await background;

    const edit = calls.find((c) => c.url.endsWith("/webhooks/app/tok/messages/@original"));
    assert.ok(edit, "should edit the original reply");
    const sent = JSON.parse(edit.init.body);
    assert.match(sent.content, /Capital of France\?/);
    assert.match(sent.content, /Paris\./);
    assert.deepEqual(sent.allowed_mentions, { parse: [] });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("splits long text into Discord-sized chunks without losing words", () => {
  const text = Array.from({ length: 400 }, (_, i) => `word${i}`).join(" ");
  const chunks = splitMessage(text, 500);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((c) => c.length <= 500));
  assert.equal(chunks.join(" "), text);
  assert.deepEqual(splitMessage("short"), ["short"]);
});
