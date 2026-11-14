import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { buildDigest, digest, postDueDigests, tidyDigest } from "../src/commands/digest.js";
import { buildWrapped, postDueWrapped, wrapped } from "../src/commands/wrapped.js";
import worker, { SCHEDULED_POSTS_CRON } from "../src/index.js";
import { initialLastSent, isDue, localNow, parseTime } from "../src/schedule.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const READ = String((1n << 10n) | (1n << 16n));
const MANAGE = String(1n << 4n);

/** A small in-memory stand-in for D1 that understands the queries these commands use. */
function fakeDb() {
  const tables = { digests: new Map(), wrapped: new Map() };
  const tableOf = (sql) => (sql.includes("wrapped") ? tables.wrapped : tables.digests);
  const cols = {
    digests: ["channel_id", "guild_id", "topics", "hour", "minute", "last_sent", "created_by"],
    wrapped: ["channel_id", "guild_id", "about_channel_id", "frequency", "weekday", "hour", "minute", "last_sent", "created_by"],
  };
  const run = async (sql, args) => {
    const t = tableOf(sql);
    if (sql.startsWith("INSERT")) {
      const names = cols[t === tables.wrapped ? "wrapped" : "digests"];
      t.set(args[0], Object.fromEntries(names.map((n, i) => [n, args[i] ?? null])));
    } else if (sql.startsWith("UPDATE")) {
      t.get(args[1]).last_sent = args[0];
    } else if (sql.startsWith("DELETE")) {
      return { meta: { changes: t.delete(args[0]) ? 1 : 0 } };
    }
    return { meta: { changes: 1 } };
  };
  const stmt = (sql, args = []) => ({
    run: () => run(sql, args),
    all: async () => ({ results: [...tableOf(sql).values()] }),
    first: async () => tableOf(sql).get(args[0]) ?? null,
  });
  return { tables, prepare: (sql) => ({ ...stmt(sql), bind: (...args) => stmt(sql, args) }) };
}

function mock(handlers) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    url = String(url);
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url, method: init.method ?? "GET", body });
    for (const [match, respond] of handlers) {
      if (url.includes(match)) {
        const out = respond(url, body);
        return out instanceof Response ? out : Response.json(out);
      }
    }
    return Response.json({ id: "sent" });
  };
  return calls;
}

const interaction = (name, sub, options = [], perms = MANAGE) => ({
  application_id: "app",
  token: "tok",
  channel_id: "bot",
  guild_id: "g",
  member: { user: { id: "me" }, roles: [], permissions: perms },
  data: { name, options: [{ type: 1, name: sub, options }] },
});
const lastEdit = (calls) => calls.filter((c) => c.url.endsWith("/messages/@original")).at(-1)?.body;

// --- scheduling helpers ---

test("parses friendly times", () => {
  assert.deepEqual(parseTime("8am"), { hour: 8, minute: 0 });
  assert.deepEqual(parseTime("6:30 PM"), { hour: 18, minute: 30 });
  assert.deepEqual(parseTime("12am"), { hour: 0, minute: 0 });
  assert.deepEqual(parseTime("12pm"), { hour: 12, minute: 0 });
  assert.deepEqual(parseTime("18:05"), { hour: 18, minute: 5 });
  assert.throws(() => parseTime("noonish"), /couldn't read "noonish"/);
  assert.throws(() => parseTime("13pm"), /isn't a valid time/);
});

test("reads the local date and time in the bot's time zone", () => {
  // 2026-11-15 14:30 UTC is 9:30 AM Sunday in New York.
  const now = localNow("America/New_York", new Date("2026-11-15T14:30:00Z"));
  assert.deepEqual(now, { date: "2026-11-15", day: 15, weekday: 0, minutes: 9 * 60 + 30 });
});

test("a schedule is due once per day, after its time, on its day", () => {
  const sunday930 = { date: "2026-11-15", day: 15, weekday: 0, minutes: 570 };
  assert.ok(isDue({ frequency: "daily", hour: 8, minute: 0, last_sent: null }, sunday930));
  assert.ok(!isDue({ frequency: "daily", hour: 8, minute: 0, last_sent: "2026-11-15" }, sunday930), "already sent today");
  assert.ok(!isDue({ frequency: "daily", hour: 10, minute: 0 }, sunday930), "not time yet");
  assert.ok(isDue({ frequency: "weekly", weekday: 0, hour: 9, minute: 0 }, sunday930));
  assert.ok(!isDue({ frequency: "weekly", weekday: 1, hour: 9, minute: 0 }, sunday930), "wrong day");
  assert.ok(!isDue({ frequency: "monthly", hour: 9, minute: 0 }, sunday930), "monthly only on the 1st");
  assert.ok(isDue({ frequency: "monthly", hour: 9, minute: 0 }, { ...sunday930, day: 1 }));
  // Setting up at 9:30 for 8am shouldn't post immediately; for 10am it should wait until 10.
  assert.equal(initialLastSent({ frequency: "daily", hour: 8, minute: 0 }, sunday930), "2026-11-15");
  assert.equal(initialLastSent({ frequency: "daily", hour: 10, minute: 0 }, sunday930), null);
});

// --- /digest ---

test("tidyDigest keeps at most five bullet lines and drops chatter", () => {
  const raw = "Here's your digest!\n- one\n- two\n* three\n• four\n- five\n- six\nHope that helps.";
  assert.equal(tidyDigest(raw), "• one\n• two\n• three\n• four\n• five");
});

test("buildDigest asks for short linked bullets and keeps the post concise", async () => {
  let request;
  mock([["anthropic", (_u, body) => {
    request = body;
    return {
      stop_reason: "end_turn",
      content: [{ type: "text", text: "Sure!\n- [Knicks win](<https://x>) in OT\n- [Free museum day](<https://y>) Friday" }],
    };
  }]]);
  const text = await buildDigest({ TIMEZONE: "America/New_York" }, "NYC events, sports");
  assert.equal(request.tools[0].max_uses, 3);
  assert.match(request.system, /at most 5 bullets/);
  assert.match(request.system, /under 15 words/);
  assert.match(request.messages[0].content, /Topics: NYC events, sports/);
  assert.match(text, /^☀️ \*\*Daily digest\*\* · \w{3}, \w{3} \d+\n• \[Knicks win\]\(<https:\/\/x>\) in OT\n• \[Free museum day\]/);
  assert.doesNotMatch(text, /Sure!/);
});

test("/digest setup saves the schedule; only managers can set it up", async () => {
  const db = fakeDb();
  const calls = mock([]);
  await digest(
    interaction("digest", "setup", [
      { name: "topics", value: "NYC events, AI news" },
      { name: "channel", value: "news" },
      { name: "time", value: "7:30am" },
    ]),
    { DB: db, TIMEZONE: "America/New_York" },
  );
  const saved = db.tables.digests.get("news");
  assert.equal(saved.topics, "NYC events, AI news");
  assert.equal(saved.hour, 7);
  assert.equal(saved.minute, 30);
  assert.match(lastEdit(calls).content, /Daily digest set for <#news> at \*\*7:30am\*\*/);

  await assert.rejects(
    digest(interaction("digest", "setup", [{ name: "topics", value: "x" }], "0"), { DB: db }),
    /Only people who can manage channels/,
  );
  await assert.rejects(digest(interaction("digest", "off", [], "0"), { DB: db }), /Only people who can manage channels/);
});

test("due digests post once, claimed before posting", async () => {
  const db = fakeDb();
  db.tables.digests.set("news", { channel_id: "news", topics: "AI news", hour: 8, minute: 0, last_sent: null });
  db.tables.digests.set("later", { channel_id: "later", topics: "x", hour: 20, minute: 0, last_sent: null });
  let claimed;
  const calls = mock([["anthropic", () => {
    claimed = db.tables.digests.get("news").last_sent;
    return { stop_reason: "end_turn", content: [{ type: "text", text: "- [A](<https://a>) b" }] };
  }]]);
  const now = { date: "2026-11-15", day: 15, weekday: 0, minutes: 8 * 60 + 2 };
  assert.equal(await postDueDigests({ DB: db }, { now }), 1);
  assert.equal(claimed, "2026-11-15");
  const posts = calls.filter((c) => c.method === "POST" && c.url.includes("/channels/"));
  assert.equal(posts.length, 1);
  assert.ok(posts[0].url.endsWith("/channels/news/messages"));
  assert.deepEqual(posts[0].body.allowed_mentions, { parse: [] });
  assert.equal(await postDueDigests({ DB: db }, { now }), 0, "not again the same day");
});

// --- /wrapped ---

const snowAt = (ms) => String((BigInt(ms) - 1420070400000n) << 22n);

function serverFixture(now) {
  const recent = snowAt(now - 60000);
  const iso = (h) => new Date(now - h * 3600000).toISOString();
  const channels = [
    { id: "general", type: 0, last_message_id: recent, permission_overwrites: [] },
    { id: "staff", type: 0, last_message_id: recent, permission_overwrites: [{ id: "g", type: 0, allow: "0", deny: String(1n << 10n) }] },
  ];
  const general = [
    { id: "3", channel_id: "general", content: "the LIRR is late AGAIN", timestamp: iso(1), author: { id: "a", username: "ashar" }, reactions: [{ count: 5, emoji: { name: "😂" } }] },
    { id: "2", channel_id: "general", content: "tacos tonight?", timestamp: iso(2), author: { id: "s", username: "sunny" } },
    { id: "1", channel_id: "general", content: "yes", timestamp: iso(3), author: { id: "a", username: "ashar" } },
  ];
  return [
    ["/guilds/g/channels", () => channels],
    ["/guilds/g", () => ({ id: "g", roles: [{ id: "g", permissions: READ }] })],
    ["/channels/general/messages", () => general],
    ["/channels/staff", () => channels[1]],
    ["/channels/general", () => channels[0]],
  ];
}

test("buildWrapped recaps public channels only, in a few short lines", async () => {
  const now = Date.now();
  const calls = mock([
    ["anthropic", () => ({ content: [{ type: "tool_use", name: "wrapped", input: { recap: "A week of trains and tacos.", funniest_index: 1 } }] })],
    ...serverFixture(now),
  ]);
  const text = await buildWrapped({ TIMEZONE: "America/New_York" }, { guildId: "g", aboutChannelId: null, frequency: "weekly" });
  const lines = text.split("\n");
  assert.match(lines[0], /^🎁 \*\*Weekly Wrapped\*\* · \w{3} \d+–\w{3} \d+$/);
  assert.equal(lines[1], "*A week of trains and tacos.*");
  assert.match(text, /💬 3 messages from 2 people · 🏆 ashar \(2\)/);
  assert.match(text, /📍 Busiest channel: <#general>/);
  assert.match(text, /⭐ "the LIRR is late AGAIN" · ashar, 5 reactions https:\/\/discord\.com\/channels\/g\/general\/3/);
  assert.match(text, /😂 "tacos tonight\?" · sunny/);
  assert.ok(lines.length <= 7, `concise (${lines.length} lines)`);
  assert.ok(!calls.some((c) => c.url.includes("/channels/staff")), "never touches the private channel");
});

test("/wrapped refuses to cover a private channel", async () => {
  const db = fakeDb();
  mock(serverFixture(Date.now()));
  await assert.rejects(
    wrapped(interaction("wrapped", "setup", [{ name: "about", value: "staff" }]), { DB: db }),
    /only covers channels everyone in the server can see/,
  );
  assert.equal(db.tables.wrapped.size, 0);
});

test("/wrapped setup saves a weekly schedule and the 5-minute run posts it on the day", async () => {
  const db = fakeDb();
  const now = Date.now();
  const calls = mock([
    ["anthropic", () => ({ content: [{ type: "tool_use", name: "wrapped", input: { recap: "Busy week.", funniest_index: -1 } }] })],
    ...serverFixture(now),
  ]);
  await wrapped(
    interaction("wrapped", "setup", [
      { name: "channel", value: "bot" },
      { name: "day", value: "sunday" },
      { name: "time", value: "6pm" },
    ]),
    { DB: db, TIMEZONE: "America/New_York" },
  );
  const saved = db.tables.wrapped.get("bot");
  assert.equal(saved.frequency, "weekly");
  assert.equal(saved.weekday, 0);
  assert.equal(saved.hour, 18);
  assert.match(lastEdit(calls).content, /the whole server → <#bot>, every Sunday at 6pm/);

  saved.last_sent = null;
  const sundayEvening = { date: "2026-11-15", day: 15, weekday: 0, minutes: 18 * 60 + 3 };
  assert.equal(await postDueWrapped({ DB: db }, { now: sundayEvening }), 1);
  const post = calls.find((c) => c.method === "POST" && c.url.endsWith("/channels/bot/messages"));
  assert.match(post.body.content, /^🎁 \*\*Weekly Wrapped\*\*/);
  assert.equal(await postDueWrapped({ DB: db }, { now: sundayEvening }), 0, "only once");
  const monday = { date: "2026-11-16", day: 16, weekday: 1, minutes: 18 * 60 + 3 };
  assert.equal(await postDueWrapped({ DB: db }, { now: monday }), 0, "wrong day");
});

test("the 5-minute trigger runs scheduled posts and nothing else", async () => {
  const db = fakeDb();
  const calls = mock([]);
  let background = [];
  await worker.scheduled({ cron: SCHEDULED_POSTS_CRON }, { DB: db, TIMEZONE: "America/New_York" }, { waitUntil: (p) => background.push(p) });
  await Promise.all(background);
  assert.equal(background.length, 1);
  assert.equal(calls.length, 0, "nothing due, nothing posted");
});
