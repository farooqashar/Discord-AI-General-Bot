import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { basePermissions, channelPermissions, computeStats, formatStats, snowflakeTime, stats } from "../src/commands/stats.js";
import { fetchHistory } from "../src/discord.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const m = (id, name, content, iso, extra = {}) => ({
  id,
  content,
  timestamp: iso,
  author: { id: name, username: name },
  ...extra,
});

const SAMPLE = [
  m("1", "ashar", "ramen tonight? 🍜🍜 https://maps.example/x", "2026-11-13T23:10:00Z"), // Fri 6 PM ET
  m("2", "sunny", "ramen again lol <:pepe:123>", "2026-11-13T23:20:00Z", {
    reactions: [{ count: 4, emoji: { name: "😂" } }],
  }),
  m("3", "ashar", "the LIRR is late again 😭", "2026-11-12T12:00:00Z", { attachments: [{}] }),
  m("4", "javier", "ramen is mid", "2026-11-13T23:40:00Z"),
];

test("counts people, words, emoji, links, files and the most reacted message", () => {
  const s = computeStats(SAMPLE, "America/New_York");
  assert.equal(s.total, 4);
  assert.equal(s.peopleCount, 3);
  assert.deepEqual(s.people[0], ["ashar", 2]);
  assert.deepEqual(s.words[0], ["ramen", 3]);
  for (const filler of ["the", "lol", "again", "https", "tonight?"]) {
    assert.ok(!s.words.some(([w]) => w === filler), `"${filler}" isn't counted`);
  }
  assert.deepEqual(s.emoji[0], ["😂", 4], "reactions count toward emoji");
  assert.ok(s.emoji.some(([e, n]) => e === "🍜" && n === 2));
  assert.ok(s.emoji.some(([e]) => e === "<:pepe:123>"));
  assert.equal(s.links, 1);
  assert.equal(s.files, 1);
  assert.equal(s.busiestDay, "Friday");
  assert.equal(s.busiestHour, 18);
  assert.equal(s.mostReacted.message.id, "2");
});

test("formats a readable summary", () => {
  const text = formatStats(computeStats(SAMPLE, "America/New_York"), {
    where: "this channel",
    days: 7,
    guildId: "g",
    channelId: "c",
  });
  assert.match(text, /^📊 \*\*Stats for this channel\*\* · last 7 days/);
  assert.match(text, /\*\*4\*\* messages from \*\*3\*\* people · ~1\/day · 🔗 1 link · 📎 1 file$/m);
  assert.match(text, /`▰▰▰▰▰▰▰▰` ashar · 2/);
  assert.match(text, /\*\*Busiest:\*\* Fridays around 6 PM/);
  assert.match(text, /\*\*Most reacted:\*\* "ramen again lol <:pepe:123>" \(sunny, 4 reactions\) https:\/\/discord\.com\/channels\/g\/c\/2/);
});

test("fetchHistory stops at messages older than the cutoff", async () => {
  const day = (d) => `2026-11-${String(d).padStart(2, "0")}T12:00:00Z`;
  const page1 = Array.from({ length: 100 }, (_, i) => m(String(1000 - i), "a", "x", day(13)));
  const page2 = [m("899", "a", "x", day(12)), m("898", "a", "x", day(1))];
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls++;
    return Response.json(String(url).includes("before=") ? page2 : page1);
  };
  const out = await fetchHistory({}, "c", 1000, { since: new Date(day(10)) });
  assert.equal(out.length, 101);
  assert.equal(calls, 2, "no more pages after reaching old messages");
});

test("/stats skips bots and reads only the requested days", async () => {
  const now = Date.now();
  const iso = (hoursAgo) => new Date(now - hoursAgo * 3600000).toISOString();
  const edits = [];
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).includes("/channels/c1/messages")) {
      return Response.json([
        m("3", "ashar", "hi", iso(1)),
        m("2", "bot", "beep", iso(2), { author: { id: "bot", bot: true } }),
        m("1", "sunny", "old", iso(24 * 3)),
      ]);
    }
    edits.push(JSON.parse(init.body));
    return Response.json({ id: "1" });
  };
  await stats(
    {
      application_id: "app",
      token: "t",
      channel_id: "c1",
      guild_id: "g",
      data: { options: [{ name: "channel", value: "c1" }, { name: "days", value: 2 }] },
    },
    {},
  );
  assert.match(edits[0].content, /\*\*1\*\* messages from \*\*1\*\* person/);
  assert.match(edits[0].content, /last 2 days/);
});

const VIEW = 1n << 10n;
const HISTORY = 1n << 16n;
const READ = String(VIEW | HISTORY);
const canRead = (p) => (p & VIEW) !== 0n && (p & HISTORY) !== 0n;

test("works out which channels the asker can read, like Discord does", () => {
  const member = { user: { id: "me" }, roles: ["mods"], permissions: READ };
  const guild = "g";
  const open = { id: "general", permission_overwrites: [] };
  const hidden = { id: "staff", permission_overwrites: [{ id: guild, type: 0, allow: "0", deny: String(VIEW) }] };
  const modsOnly = {
    id: "mods-chat",
    permission_overwrites: [
      { id: guild, type: 0, allow: "0", deny: String(VIEW) },
      { id: "mods", type: 0, allow: String(VIEW), deny: "0" },
    ],
  };
  const blockedForMe = {
    id: "secret",
    permission_overwrites: [{ id: "me", type: 1, allow: "0", deny: String(VIEW) }],
  };
  assert.ok(canRead(channelPermissions(member, guild, open)));
  assert.ok(!canRead(channelPermissions(member, guild, hidden)));
  assert.ok(canRead(channelPermissions(member, guild, modsOnly)));
  assert.ok(!canRead(channelPermissions(member, guild, blockedForMe)));
  const admin = { user: { id: "a" }, roles: [], permissions: String(1n << 3n) };
  assert.ok(canRead(channelPermissions(admin, guild, hidden)), "admins see everything");
});

test("snowflake IDs convert to the time they were made", () => {
  // Discord's documented example ID.
  assert.equal(new Date(snowflakeTime("175928847299117063")).toISOString(), "2016-04-30T11:18:25.796Z");
});

// A snowflake for "hoursAgo" hours ago, so channels look recently active.
const snowAt = (ms) => String((BigInt(ms) - 1420070400000n) << 22n);

test("server-wide /stats reads only channels the asker can read and skips quiet ones", async () => {
  const now = Date.now();
  const recent = snowAt(now - 3600000);
  const old = snowAt(now - 40 * 86400000);
  const iso = (h) => new Date(now - h * 3600000).toISOString();
  const channels = [
    { id: "general", type: 0, last_message_id: recent, permission_overwrites: [] },
    { id: "food", type: 0, last_message_id: recent, permission_overwrites: [] },
    { id: "staff", type: 0, last_message_id: recent, permission_overwrites: [{ id: "g", type: 0, allow: "0", deny: String(VIEW) }] },
    { id: "dead", type: 0, last_message_id: old, permission_overwrites: [] },
    { id: "voice", type: 2, last_message_id: recent, permission_overwrites: [] },
  ];
  const fetched = [];
  const edits = [];
  globalThis.fetch = async (url, init = {}) => {
    url = String(url);
    if (url.endsWith("/guilds/g/channels")) return Response.json(channels);
    if (url.endsWith("/guilds/g")) return Response.json({ id: "g", owner_id: "owner", roles: [{ id: "g", permissions: READ }] });
    const match = url.match(/\/channels\/(\w+)\/messages/);
    if (match) {
      fetched.push(match[1]);
      const id = match[1];
      return Response.json([
        { id: `${id}2`, content: `${id} chat`, timestamp: iso(1), author: { id: "sam", username: "sam" } },
        { id: `${id}1`, content: "older", timestamp: iso(2), author: { id: "jo", username: "jo" } },
      ]);
    }
    edits.push(JSON.parse(init.body));
    return Response.json({ id: "1" });
  };

  await stats(
    {
      application_id: "app",
      token: "t",
      channel_id: "general",
      guild_id: "g",
      member: { user: { id: "me" }, roles: [], permissions: READ },
      data: { options: [] },
    },
    {},
  );

  assert.deepEqual(fetched.sort(), ["food", "general"], "no hidden, quiet or voice channels");
  const text = edits.at(-1).content;
  assert.match(text, /^📊 \*\*Stats for the server\*\* · last 7 days/);
  assert.match(text, /\*\*4\*\* messages from \*\*2\*\* people/);
  assert.match(text, /\*\(2 channels you can read\)\*/);
  assert.match(text, /\*\*Most active channels\*\*\n`▰▰▰▰▰▰▰▰` <#(general|food)> · 2/);
});

test("server-wide /stats stops at the request budget and says so", async () => {
  const now = Date.now();
  const recent = snowAt(now - 60000);
  const channels = Array.from({ length: 60 }, (_, i) => ({ id: `c${i}`, type: 0, last_message_id: recent, permission_overwrites: [] }));
  let pages = 0;
  const edits = [];
  globalThis.fetch = async (url, init = {}) => {
    url = String(url);
    if (url.endsWith("/guilds/g/channels")) return Response.json(channels);
    if (url.endsWith("/guilds/g")) return Response.json({ id: "g", owner_id: "owner", roles: [{ id: "g", permissions: READ }] });
    if (url.includes("/messages?limit=100")) {
      pages++;
      return Response.json([{ id: "1", content: "hi", timestamp: new Date(now - 1000).toISOString(), author: { id: "a", username: "a" } }]);
    }
    edits.push(JSON.parse(init.body));
    return Response.json({ id: "1" });
  };
  await stats(
    { application_id: "app", token: "t", channel_id: "c0", guild_id: "g", member: { user: { id: "me" }, roles: [], permissions: READ }, data: { options: [] } },
    {},
  );
  assert.equal(pages, 40);
  assert.match(edits.at(-1).content, /stopped early on the busiest channels/);
});

test("server-wide permissions come from roles, not the channel the command ran in", () => {
  const guild = {
    id: "g",
    owner_id: "owner",
    roles: [
      { id: "g", permissions: "0" }, // @everyone can't see anything by default
      { id: "members", permissions: READ },
      { id: "admins", permissions: String(1n << 3n) },
    ],
  };
  assert.equal(basePermissions(guild, { user: { id: "x" }, roles: [] }), 0n);
  assert.ok(canRead(basePermissions(guild, { user: { id: "x" }, roles: ["members"] })));
  assert.ok(canRead(basePermissions(guild, { user: { id: "x" }, roles: ["admins"] })));
  assert.ok(canRead(basePermissions(guild, { user: { id: "owner" }, roles: [] })));

  // Someone with no role, who ran the command in a channel that lets them in,
  // still can't read an ordinary channel with no overrides.
  const noRole = { user: { id: "x" }, roles: [], permissions: READ };
  const plain = { id: "general", permission_overwrites: [] };
  assert.ok(!canRead(channelPermissions(noRole, "g", plain, basePermissions(guild, noRole))));
});
