import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { channelIsPublic } from "../src/commands/stats.js";
import { EPHEMERAL, targetChannel } from "../src/discord.js";
import worker, { replyFlags } from "../src/index.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const READ = String((1n << 10n) | (1n << 16n)); // View Channel + Read Message History
const HIDDEN = [{ id: "g", type: 0, allow: "0", deny: String(1n << 10n) }];

// A server where @everyone can read, #general is open and #staff is hidden.
const CHANNELS = {
  general: { id: "general", type: 0, permission_overwrites: [] },
  staff: { id: "staff", type: 0, permission_overwrites: HIDDEN },
  "staff-thread": { id: "staff-thread", type: 11, parent_id: "staff" },
  "general-thread": { id: "general-thread", type: 11, parent_id: "general" },
  "private-thread": { id: "private-thread", type: 12, parent_id: "general" },
};

function mockServer() {
  const calls = [];
  globalThis.fetch = async (url) => {
    url = String(url);
    calls.push(url);
    if (url.endsWith("/guilds/g")) return Response.json({ id: "g", roles: [{ id: "g", permissions: READ }] });
    const id = url.match(/\/channels\/([\w-]+)$/)?.[1];
    if (id && CHANNELS[id]) return Response.json(CHANNELS[id]);
    return Response.json({ id: "1" });
  };
  return calls;
}

const interaction = (name, channel, extra = {}) => ({
  type: 2,
  application_id: "app",
  token: "tok",
  guild_id: "g",
  channel_id: "general",
  member: { user: { id: "mod" }, roles: ["mods"], permissions: READ },
  data: {
    name,
    options: channel ? [{ name: "channel", value: channel }] : [],
    resolved: channel ? { channels: { [channel]: { permissions: READ } } } : undefined,
  },
  ...extra,
});

test("a mod can still read a private channel they can see, but the reply is only for them", async () => {
  mockServer();
  const fromStaff = interaction("tldr", "staff");
  assert.equal(targetChannel(fromStaff), "staff", "the asker's own access check still passes");
  for (const name of ["tldr", "ask", "vibe-check", "roast", "stats"]) {
    assert.equal(await replyFlags(interaction(name, "staff"), {}), EPHEMERAL, `/${name} from #staff`);
  }
});

test("public-to-public and same-channel replies stay public without extra lookups", async () => {
  const calls = mockServer();
  assert.equal(await replyFlags(interaction("tldr", "general-thread"), {}), undefined);
  calls.length = 0;
  assert.equal(await replyFlags(interaction("tldr"), {}), undefined);
  assert.equal(await replyFlags(interaction("tldr", "general"), {}), undefined);
  assert.equal(await replyFlags(interaction("stats"), {}), undefined, "server-wide /stats only counts public channels");
  assert.equal(await replyFlags(interaction("research", "staff"), {}), undefined, "commands that don't read chat");
  assert.deepEqual(calls, []);
});

test("threads follow their parent, and private threads and failed lookups are never public", async () => {
  mockServer();
  assert.equal(await channelIsPublic({}, "g", "staff-thread"), false);
  assert.equal(await channelIsPublic({}, "g", "general-thread"), true);
  assert.equal(await channelIsPublic({}, "g", "private-thread"), false);

  globalThis.fetch = async () => new Response("{}", { status: 500 });
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(await replyFlags(interaction("tldr", "staff"), {}), EPHEMERAL);
  } finally {
    console.warn = warn;
  }
});

test("/tldr channel:#staff run in #general is deferred as an ephemeral reply", async () => {
  const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const toHex = (buf) => Buffer.from(buf).toString("hex");
  const publicKeyHex = toHex(await crypto.subtle.exportKey("raw", keys.publicKey));
  const body = JSON.stringify(interaction("tldr", "staff"));
  const timestamp = String(Math.floor(Date.now() / 1000));
  const sig = await crypto.subtle.sign("Ed25519", keys.privateKey, new TextEncoder().encode(timestamp + body));
  const request = new Request("https://bot.example/", {
    method: "POST",
    headers: { "X-Signature-Ed25519": toHex(sig), "X-Signature-Timestamp": timestamp },
    body,
  });

  mockServer();
  const ctx = { waitUntil: () => {} };
  const res = await worker.fetch(request, { DISCORD_PUBLIC_KEY: publicKeyHex, DISCORD_TOKEN: "t" }, ctx);
  assert.deepEqual(await res.json(), { type: 5, data: { flags: EPHEMERAL } });
});
