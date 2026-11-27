import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { countdown, countdownLine, formatRemaining, postDueCountdowns } from "../src/commands/countdown.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function mock(handlers = []) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    url = String(url);
    calls.push({ url, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : undefined });
    for (const [match, respond] of handlers) if (url.includes(match)) return Response.json(await respond(url, init));
    return Response.json({ id: "sent" });
  };
  return calls;
}

function fakeDb() {
  const rows = [];
  let nextId = 1;
  const stmt = (sql, args = []) => ({
    async run() {
      if (sql.startsWith("INSERT INTO countdowns")) {
        const [guild_id, channel_id, name, target_at, created_by, created_at] = args;
        rows.push({ id: nextId++, guild_id, channel_id, name, target_at, created_by, created_at });
      } else if (sql.startsWith("DELETE FROM countdowns")) {
        const i = rows.findIndex((r) => r.id === args[0]);
        if (i === -1) return { meta: { changes: 0 } };
        rows.splice(i, 1);
      }
      return { meta: { changes: 1 } };
    },
    async all() {
      const sorted = [...rows].sort((a, b) => a.target_at - b.target_at);
      if (sql.includes("WHERE guild_id")) return { results: sorted.filter((r) => r.guild_id === args[0]).slice(0, args[1]) };
      return { results: sorted.filter((r) => r.target_at <= args[0]).slice(0, args[1]) };
    },
  });
  return { rows, prepare: (sql) => ({ ...stmt(sql), bind: (...args) => stmt(sql, args) }) };
}

const H = 3600 * 1000;
const D = 24 * H;

test("shows days, then hours/minutes/seconds on the last day", () => {
  assert.equal(formatRemaining(116 * D + 3 * H), "116 days");
  assert.equal(formatRemaining(D + 4 * H), "1 day, 4 hours");
  assert.equal(formatRemaining(D + 1 * H), "1 day, 1 hour");
  assert.equal(formatRemaining(5 * H + 23 * 60000 + 10000), "5h 23m 10s");
  assert.equal(formatRemaining(3 * 60000 + 5000), "3m 5s");
  assert.equal(formatRemaining(42000), "42s");
  assert.equal(formatRemaining(-5), "now");
  const now = Date.UTC(2026, 10, 18);
  assert.match(countdownLine({ name: "Japan trip", target_at: (now + 116 * D) / 1000 }, now), /^📅 \*\*Japan trip\*\*: 116 days left · <t:\d+:f> \(<t:\d+:R>\)$/);
  assert.match(countdownLine({ name: "Launch", target_at: (now + 2 * H) / 1000 }, now), /^⏳ \*\*Launch\*\*: 2h 0m 0s left/);
});

const base = { application_id: "app", token: "t", guild_id: "g", channel_id: "c1", member: { user: { id: "me" }, permissions: "0" } };
const sub = (name, options = []) => ({ ...base, data: { name: "countdown", options: [{ type: 1, name, options }] } });
const lastReply = (calls) => calls.filter((c) => c.url.endsWith("/messages/@original")).at(-1).body.content;

test("adds, lists and removes countdowns", async () => {
  const DB = fakeDb();
  const target = new Date(Date.now() + 116 * D + 60000).toISOString();
  const calls = mock([["anthropic", () => ({ content: [{ type: "tool_use", name: "set_countdown", input: { target_at: target, missing_info: null } }] })]]);
  await countdown(sub("add", [{ name: "name", value: "Japan trip" }, { name: "when", value: "march 14" }]), { DB });
  assert.match(lastReply(calls), /Countdown started!\n📅 \*\*Japan trip\*\*: 116 days left.*\nI'll post here when the time comes\./s);
  assert.deepEqual([DB.rows[0].channel_id, DB.rows[0].created_by], ["c1", "me"]);

  await assert.rejects(countdown(sub("add", [{ name: "name", value: "japan TRIP" }, { name: "when", value: "x" }]), { DB }), /already a countdown/);

  await countdown(sub("list"), { DB });
  assert.match(lastReply(calls), /^\*\*Countdowns\*\*\n📅 \*\*Japan trip\*\*: 116 days left/);

  await assert.rejects(
    countdown({ ...sub("remove", [{ name: "name", value: "Japan trip" }]), member: { user: { id: "someone" }, permissions: "0" } }, { DB }),
    /Only the person who started/,
  );
  // Removing needs the exact name; a partial one only gets a suggestion.
  await assert.rejects(countdown(sub("remove", [{ name: "name", value: "japan" }]), { DB }), /Did you mean \*\*Japan trip\*\*/);
  assert.equal(DB.rows.length, 1);
  await countdown(sub("remove", [{ name: "name", value: "japan TRIP" }]), { DB });
  assert.equal(DB.rows.length, 0);
  await countdown(sub("list"), { DB });
  assert.match(lastReply(calls), /No countdowns yet/);
});

test("rejects past dates and unclear ones", async () => {
  const DB = fakeDb();
  mock([["anthropic", () => ({ content: [{ type: "tool_use", name: "set_countdown", input: { target_at: "2020-01-01T00:00:00Z", missing_info: null } }] })]]);
  await assert.rejects(countdown(sub("add", [{ name: "name", value: "x" }, { name: "when", value: "jan 1 2020" }]), { DB }), /already passed/);
  mock([["anthropic", () => ({ content: [{ type: "tool_use", name: "set_countdown", input: { target_at: "", missing_info: "No date was given." } }] })]]);
  await assert.rejects(countdown(sub("add", [{ name: "name", value: "x" }, { name: "when", value: "soon" }]), { DB }), /No date was given/);
  assert.equal(DB.rows.length, 0);
});

test("posts an alert when a countdown hits zero, only once", async () => {
  const DB = fakeDb();
  const now = Math.floor(Date.now() / 1000);
  DB.rows.push({ id: 1, guild_id: "g", channel_id: "c1", name: "Japan trip", target_at: now - 10, created_by: "me" });
  DB.rows.push({ id: 2, guild_id: "g", channel_id: "c1", name: "Later", target_at: now + 3600, created_by: "me" });
  const calls = mock();
  await postDueCountdowns({ DB });
  await postDueCountdowns({ DB });
  const posts = calls.filter((c) => c.method === "POST" && c.url.endsWith("/channels/c1/messages"));
  assert.equal(posts.length, 1);
  assert.equal(posts[0].body.embeds[0].title, "🎉 It's time: Japan trip!");
  assert.deepEqual(posts[0].body.allowed_mentions, { users: ["me"] });
  assert.deepEqual(DB.rows.map((r) => r.name), ["Later"]);
});

test("retries an alert after a Discord hiccup", async () => {
  const DB = fakeDb();
  DB.rows.push({ id: 1, guild_id: "g", channel_id: "c1", name: "Launch", target_at: Math.floor(Date.now() / 1000) - 5, created_by: "me" });
  globalThis.fetch = async () => new Response("oops", { status: 502 });
  await postDueCountdowns({ DB });
  assert.deepEqual(DB.rows.map((r) => r.name), ["Launch"], "kept for the next minute");
});

test("a private channel's countdowns only show up in that channel", async () => {
  const DB = fakeDb();
  const later = (days) => Math.floor((Date.now() + days * D) / 1000);
  DB.rows.push({ id: 1, guild_id: "g", channel_id: "general", name: "Japan trip", target_at: later(10), created_by: "me" });
  DB.rows.push({ id: 2, guild_id: "g", channel_id: "planning", name: "Sam's surprise party", target_at: later(20), created_by: "me" });
  const READ = String((1n << 10n) | (1n << 16n));
  const channels = [
    { id: "general", type: 0, permission_overwrites: [] },
    { id: "planning", type: 0, permission_overwrites: [{ id: "g", type: 0, allow: "0", deny: READ }] },
  ];
  const calls = mock([
    ["/guilds/g/channels", () => channels],
    ["/guilds/g", () => ({ id: "g", roles: [{ id: "g", permissions: READ }] })],
  ]);
  const inChannel = (channel_id, interaction) => ({ ...interaction, channel_id });

  await countdown(inChannel("general", sub("list")), { DB });
  assert.match(lastReply(calls), /Japan trip/);
  assert.doesNotMatch(lastReply(calls), /surprise/);

  await countdown(inChannel("planning", sub("list")), { DB });
  assert.match(lastReply(calls), /Japan trip.*\n.*Sam's surprise party/);

  await countdown(inChannel("random", sub("list")), { DB });
  assert.doesNotMatch(lastReply(calls), /surprise/, "not from another public channel either");

  await assert.rejects(countdown(inChannel("general", sub("list", [{ name: "name", value: "party" }])), { DB }), /couldn't find/);
  await countdown(inChannel("planning", sub("list", [{ name: "name", value: "party" }])), { DB });
  assert.match(lastReply(calls), /Sam's surprise party/);

  await assert.rejects(countdown(inChannel("general", sub("remove", [{ name: "name", value: "Sam's surprise party" }])), { DB }), /couldn't find/);
  assert.equal(DB.rows.length, 2);

  // If Discord can't be reached, only this channel's countdowns are shown.
  const replies = [];
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).endsWith("/messages/@original")) {
      replies.push(JSON.parse(init.body).content);
      return Response.json({ id: "sent" });
    }
    return new Response("oops", { status: 500 });
  };
  await countdown(inChannel("general", sub("list")), { DB });
  assert.match(replies.at(-1), /Japan trip/);
  assert.doesNotMatch(replies.at(-1), /surprise/, "the private countdown stays hidden");
  await countdown(inChannel("planning", sub("list")), { DB });
  assert.match(replies.at(-1), /Sam's surprise party/);
  assert.doesNotMatch(replies.at(-1), /Japan trip/, "only this channel's own countdowns");
  await countdown(inChannel("planning", sub("remove", [{ name: "name", value: "Sam's surprise party" }])), { DB });
  assert.deepEqual(DB.rows.map((r) => r.name), ["Japan trip"]);
});

test("countdowns hidden from a channel never change what it finds or removes", async () => {
  const DB = fakeDb();
  const later = (days) => Math.floor((Date.now() + days * D) / 1000);
  DB.rows.push({ id: 2, guild_id: "g", channel_id: "general", name: "Party planning", target_at: later(10), created_by: "me" });
  const READ = String((1n << 10n) | (1n << 16n));
  const calls = mock([
    [
      "/guilds/g/channels",
      () => [
        { id: "general", type: 0, permission_overwrites: [] },
        { id: "planning", type: 0, permission_overwrites: [{ id: "g", type: 0, allow: "0", deny: READ }] },
      ],
    ],
    ["/guilds/g", () => ({ id: "g", roles: [{ id: "g", permissions: READ }] })],
  ]);
  const inChannel = (channel_id, interaction) => ({ ...interaction, channel_id });
  const party = [{ name: "name", value: "Party" }];

  // What #general sees, with and without a private "Party" in #planning.
  const seen = async () => {
    await countdown(inChannel("general", sub("list", party)), { DB });
    const listed = lastReply(calls);
    const removed = await countdown(inChannel("general", sub("remove", party)), { DB }).then(
      () => "removed",
      (err) => err.message,
    );
    return { listed, removed };
  };
  const without = await seen();
  DB.rows.push({ id: 1, guild_id: "g", channel_id: "planning", name: "Party", target_at: later(5), created_by: "me" });
  const withHidden = await seen();

  assert.deepEqual(withHidden, without, "a hidden countdown leaves no trace in #general");
  assert.match(without.listed, /Party planning/);
  assert.match(without.removed, /Did you mean \*\*Party planning\*\*/, "a partial name never removes anything");
  assert.deepEqual(DB.rows.map((r) => r.name).sort(), ["Party", "Party planning"], "nothing removed from outside the channel");

  await countdown(inChannel("planning", sub("remove", party)), { DB });
  assert.deepEqual(DB.rows.map((r) => r.name), ["Party planning"], "the exact match is removed where it's visible");
});

test("threads follow their parent channel, private threads stay private", async () => {
  const DB = fakeDb();
  const later = (days) => Math.floor((Date.now() + days * D) / 1000);
  DB.rows.push({ id: 1, guild_id: "g", channel_id: "public-thread", name: "Open plan", target_at: later(1), created_by: "me" });
  DB.rows.push({ id: 2, guild_id: "g", channel_id: "private-thread", name: "Secret plan", target_at: later(2), created_by: "me" });
  DB.rows.push({ id: 3, guild_id: "g", channel_id: "deleted", name: "Gone plan", target_at: later(3), created_by: "me" });
  const READ = String((1n << 10n) | (1n << 16n));
  const calls = mock([
    ["/guilds/g/channels", () => [{ id: "general", type: 0, permission_overwrites: [] }]],
    ["/guilds/g", () => ({ id: "g", roles: [{ id: "g", permissions: READ }] })],
    ["/channels/public-thread", () => ({ id: "public-thread", type: 11, parent_id: "general" })],
    ["/channels/private-thread", () => ({ id: "private-thread", type: 12, parent_id: "general" })],
  ]);
  const mocked = globalThis.fetch;
  globalThis.fetch = async (url, init) =>
    String(url).endsWith("/channels/deleted") ? Response.json({ message: "Unknown Channel" }, { status: 404 }) : mocked(url, init);
  await countdown({ ...sub("list"), channel_id: "general" }, { DB });
  assert.match(lastReply(calls), /Open plan/);
  assert.doesNotMatch(lastReply(calls), /Secret plan|Gone plan/);
});

test("a channel lookup that never answers counts as private instead of holding up the reply", { timeout: 2000 }, async () => {
  const DB = fakeDb();
  const later = (days) => Math.floor((Date.now() + days * D) / 1000);
  DB.rows.push({ id: 1, guild_id: "g", channel_id: "general", name: "Japan trip", target_at: later(1), created_by: "me" });
  DB.rows.push({ id: 2, guild_id: "g", channel_id: "slow-thread", name: "Slow plan", target_at: later(2), created_by: "me" });
  const READ = String((1n << 10n) | (1n << 16n));
  const calls = mock([
    ["/guilds/g/channels", () => [{ id: "general", type: 0, permission_overwrites: [] }]],
    ["/guilds/g", () => ({ id: "g", roles: [{ id: "g", permissions: READ }] })],
  ]);
  const mocked = globalThis.fetch;
  globalThis.fetch = async (url, init) =>
    String(url).endsWith("/channels/slow-thread")
      ? new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal.reason)))
      : mocked(url, init);
  await countdown({ ...sub("list"), channel_id: "general" }, { DB, visibilityTimeoutMs: 50 });
  assert.match(lastReply(calls), /Japan trip/);
  assert.doesNotMatch(lastReply(calls), /Slow plan/);
});
