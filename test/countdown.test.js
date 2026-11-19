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
    countdown({ ...sub("remove", [{ name: "name", value: "japan" }]), member: { user: { id: "someone" }, permissions: "0" } }, { DB }),
    /Only the person who started/,
  );
  await countdown(sub("remove", [{ name: "name", value: "japan" }]), { DB });
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
