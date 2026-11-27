import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { autoPin, findMatches, pinAll, runDueAutoPins } from "../src/commands/auto-pin.js";
import { replyFlags } from "../src/index.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const READ = String((1n << 10n) | (1n << 16n));
const MANAGE = String((1n << 4n) | (1n << 10n) | (1n << 16n));

function fakeDb() {
  const table = new Map();
  const cols = ["channel_id", "guild_id", "rule", "hour", "minute", "report_channel_id", "last_sent", "created_by", "max_pins"];
  const stmt = (sql, args = []) => ({
    run: async () => {
      if (sql.startsWith("INSERT")) table.set(args[0], Object.fromEntries(cols.map((c, i) => [c, args[i] ?? null])));
      if (sql.startsWith("UPDATE")) table.get(args[1]).last_sent = args[0];
      if (sql.startsWith("DELETE")) return { meta: { changes: table.delete(args[0]) ? 1 : 0 } };
      return { meta: { changes: 1 } };
    },
    all: async () => ({ results: [...table.values()] }),
    first: async () => table.get(args[0]) ?? null,
  });
  return { table, prepare: (sql) => ({ ...stmt(sql), bind: (...args) => stmt(sql, args) }) };
}

function mock(handlers) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    url = String(url);
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url, method: init.method ?? "GET", body });
    for (const [match, respond] of handlers) {
      if (url.includes(match)) {
        const out = respond(url, body, init);
        return out instanceof Response ? out : Response.json(out);
      }
    }
    return Response.json({ id: "sent" });
  };
  return calls;
}

const iso = (hoursAgo) => new Date(Date.now() - hoursAgo * 3600000).toISOString();
const HISTORY = [
  { id: "4", content: "lol", timestamp: iso(1), author: { id: "a", username: "ashar" } },
  { id: "3", content: "Dinner Fri 7pm at Joe's Shanghai, booked!", timestamp: iso(2), author: { id: "s", username: "sunny" } },
  { id: "2", content: "Try Xi'an Famous Foods, the noodles slap", timestamp: iso(3), author: { id: "j", username: "javier" }, pinned: true },
  { id: "1", content: "beep", timestamp: iso(4), author: { id: "bot", bot: true } },
];

const ai = (indexes) => ["anthropic", (_u, body) => ({ content: [{ type: "tool_use", name: "pick_messages", input: { indexes } }] })];

const interaction = (sub, options, perms = MANAGE) => ({
  application_id: "app",
  token: "tok",
  channel_id: "bot",
  guild_id: "g",
  member: { user: { id: "me" }, roles: [], permissions: perms },
  data: {
    name: "auto-pin",
    options: [{ type: 1, name: sub, options }],
    resolved: { channels: { general: { id: "general", permissions: READ } } },
  },
});
const lastEdit = (calls) => calls.filter((c) => c.url.endsWith("/messages/@original")).at(-1)?.body;

test("findMatches shows the AI only unpinned human messages and keeps valid picks", async () => {
  let prompt;
  mock([
    ["anthropic", (_u, body) => {
      prompt = body.messages[0].content;
      return { content: [{ type: "tool_use", name: "pick_messages", input: { indexes: [0, 0, 7] } }] };
    }],
    ["/channels/general/messages", () => HISTORY],
  ]);
  const matches = await findMatches({}, "general", "confirmed plans");
  assert.match(prompt, /Pin messages that match: "confirmed plans"/);
  assert.match(prompt, /0: sunny: Dinner Fri 7pm/);
  assert.doesNotMatch(prompt, /Xi'an|beep/, "already-pinned and bot messages are skipped");
  assert.deepEqual(matches.map((m) => m.id), ["3"], "duplicates and out-of-range picks dropped");
});

test("pinAll uses Discord's pin endpoint and explains a missing permission", async () => {
  const calls = mock([["/messages/pins/", () => new Response(null, { status: 204 })]]);
  const out = await pinAll({}, "general", [{ id: "3" }]);
  assert.equal(out.pinned.length, 1);
  assert.equal(calls[0].method, "PUT");
  assert.ok(calls[0].url.endsWith("/channels/general/messages/pins/3"));

  mock([["/messages/pins/", () => new Response('{"code":50013}', { status: 403 })]]);
  await assert.rejects(pinAll({}, "general", [{ id: "3" }]), /Pin Messages permission/);
});

test("pinAll stops when the channel is full", async () => {
  mock([["/messages/pins/", () => new Response('{"code":30003,"message":"Maximum number of pins reached"}', { status: 400 })]]);
  const out = await pinAll({}, "general", [{ id: "3" }, { id: "5" }]);
  assert.deepEqual(out, { pinned: [], full: true });
});

test("/auto-pin setup needs Manage Channels and a channel you can read", async () => {
  const db = fakeDb();
  const calls = mock([]);
  await autoPin(
    interaction("setup", [
      { name: "channel", value: "general" },
      { name: "rule", value: "restaurant recs and confirmed plans" },
      { name: "time", value: "11:58pm" },
      { name: "report", value: "bot" },
      { name: "max", value: 12 },
    ]),
    { DB: db, TIMEZONE: "America/New_York" },
  );
  const saved = db.table.get("general");
  assert.equal(saved.rule, "restaurant recs and confirmed plans");
  assert.equal(saved.hour, 23);
  assert.equal(saved.minute, 55, "rounded down so the 5-minute run reaches it");
  assert.equal(saved.report_channel_id, "bot");
  assert.equal(saved.max_pins, 12);
  assert.match(lastEdit(calls).content, /Every day at \*\*11:55pm\*\* I'll pin up to 12 messages/);

  await assert.rejects(
    autoPin(interaction("setup", [{ name: "channel", value: "general" }, { name: "rule", value: "x" }], READ), { DB: db }),
    /Only people who can manage channels/,
  );
  const hidden = interaction("setup", [{ name: "channel", value: "secret" }, { name: "rule", value: "x" }]);
  hidden.data.resolved.channels.secret = { id: "secret", permissions: "0" };
  await assert.rejects(autoPin(hidden, { DB: fakeDb() }), /only auto-pin channels you can read/);
});

test("/auto-pin now previews without pinning", async () => {
  const db = fakeDb();
  const calls = mock([ai([0]), ["/channels/general/messages", () => HISTORY]]);
  await autoPin(interaction("now", [{ name: "channel", value: "general" }, { name: "rule", value: "plans" }]), { DB: db });
  assert.ok(!calls.some((c) => c.method === "PUT"), "nothing pinned");
  const text = lastEdit(calls).content;
  assert.match(text, /Preview:\*\* I'd pin 1 .* \(nothing was pinned\)/);
  assert.match(text, /"Dinner Fri 7pm at Joe's Shanghai, booked!" · sunny https:\/\/discord\.com\/channels\/g\/general\/3/);
});

test("the daily run pins matches once and reports links only", async () => {
  const db = fakeDb();
  db.table.set("general", { channel_id: "general", guild_id: "g", rule: "plans", hour: 23, minute: 0, report_channel_id: "bot", last_sent: null });
  const calls = mock([
    ai([0]),
    ["/channels/general/messages/pins/", () => new Response(null, { status: 204 })],
    ["/channels/general/messages", () => HISTORY],
  ]);
  const now = { date: "2026-11-16", day: 16, weekday: 1, minutes: 23 * 60 + 2 };
  assert.equal(await runDueAutoPins({ DB: db }, { now }), 1);

  const pins = calls.filter((c) => c.method === "PUT");
  assert.equal(pins.length, 1);
  const report = calls.find((c) => c.method === "POST" && c.url.endsWith("/channels/bot/messages"));
  assert.equal(report.body.content, "📌 Pinned 1 message in <#general> today:\nhttps://discord.com/channels/g/general/3");
  assert.doesNotMatch(report.body.content, /Joe's/, "no message text in the report");
  assert.equal(await runDueAutoPins({ DB: db }, { now }), 0, "only once a day");
});

test("a quiet day pins nothing and posts no report", async () => {
  const db = fakeDb();
  db.table.set("general", { channel_id: "general", guild_id: "g", rule: "plans", hour: 23, minute: 0, report_channel_id: "bot", last_sent: null });
  const calls = mock([ai([]), ["/channels/general/messages", () => HISTORY]]);
  await runDueAutoPins({ DB: db }, { now: { date: "2026-11-16", day: 16, weekday: 1, minutes: 23 * 60 + 2 } });
  const discordWrites = calls.filter((c) => c.url.includes("discord.com") && (c.method === "PUT" || c.method === "POST"));
  assert.equal(discordWrites.length, 0, "no pins, no report");
});

test("previewing a private channel replies privately", async () => {
  mock([
    ["/guilds/g/channels", () => []],
    ["/guilds/g", () => ({ id: "g", roles: [{ id: "g", permissions: READ }] })],
    ["/channels/staff", () => ({ id: "staff", permission_overwrites: [{ id: "g", type: 0, allow: "0", deny: String(1n << 10n) }] })],
  ]);
  const i = interaction("now", [{ name: "channel", value: "staff" }]);
  assert.equal(await replyFlags(i, {}), 1 << 6);
});

test("the daily limit is adjustable, capped at 20, and passed to the AI", async () => {
  const many = Array.from({ length: 30 }, (_, i) => ({
    id: String(100 - i),
    content: `"quote ${i}" - sam`,
    timestamp: iso(1),
    author: { id: "s", username: "sam" },
  }));
  let maxItems;
  mock([
    ["anthropic", (_u, body) => {
      maxItems = body.tools[0].input_schema.properties.indexes.maxItems;
      return { content: [{ type: "tool_use", name: "pick_messages", input: { indexes: Array.from({ length: 30 }, (_, i) => i) } }] };
    }],
    ["/channels/quotes/messages", () => many],
  ]);
  assert.equal((await findMatches({}, "quotes", "quotes", 12)).length, 12);
  assert.equal(maxItems, 12);
  assert.equal((await findMatches({}, "quotes", "quotes", 99)).length, 20, "never more than 20");
  assert.equal((await findMatches({}, "quotes", "quotes", null)).length, 5, "default 5");
});

test("a private channel's auto-pin only shows up in /auto-pin list there", async () => {
  const DB = fakeDb();
  DB.table.set("general", { channel_id: "general", guild_id: "g", rule: "restaurant recs", hour: 23, minute: 0 });
  DB.table.set("planning", { channel_id: "planning", guild_id: "g", rule: "Sam's surprise party", hour: 23, minute: 0 });
  const channels = [
    { id: "general", type: 0, permission_overwrites: [] },
    { id: "planning", type: 0, permission_overwrites: [{ id: "g", type: 0, allow: "0", deny: READ }] },
  ];
  const calls = mock([
    ["/guilds/g/channels", () => channels],
    ["/guilds/g", () => ({ id: "g", roles: [{ id: "g", permissions: READ }] })],
  ]);
  const list = (channel_id) => ({ ...interaction("list", [], READ), channel_id });

  await autoPin(list("general"), { DB });
  assert.match(lastEdit(calls).content, /restaurant recs/);
  assert.doesNotMatch(lastEdit(calls).content, /surprise|planning/);
  assert.match(lastEdit(calls).content, /1 more auto-pin is set up in a channel not everyone can see/);

  await autoPin(list("planning"), { DB });
  assert.match(lastEdit(calls).content, /restaurant recs[^]*Sam's surprise party/);
  assert.doesNotMatch(lastEdit(calls).content, /not everyone can see/);

  // If Discord can't be reached, only this channel's auto-pin is shown.
  const failed = mock([["/guilds/g", () => new Response("oops", { status: 500 })]]);
  await autoPin(list("planning"), { DB });
  assert.match(lastEdit(failed).content, /Sam's surprise party/);
  assert.doesNotMatch(lastEdit(failed).content, /restaurant recs/);
});
