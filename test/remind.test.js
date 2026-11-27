import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { postDueReminders, remind, reminders } from "../src/commands/remind.js";
import { syncCommandsIfChanged } from "../src/register.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** A tiny in-memory stand-in for the D1 reminders table (ids count up, LIMIT is applied). */
function fakeDb(rows = []) {
  const table = new Map(rows.map((r) => [r.id, { created_at: 0, ...r }]));
  let nextId = Math.max(0, ...table.keys()) + 1;
  const stmt = (sql, args) => ({
    run: async () => {
      if (sql.startsWith("CREATE")) {
        // The table and index already exist in memory.
      } else if (sql.startsWith("INSERT")) {
        const [channel_id, user_id, message, due_at, created_at] = args;
        const id = nextId++;
        table.set(id, { id, channel_id, user_id, message, due_at, created_at });
      } else if (sql.startsWith("DELETE")) {
        const row = table.get(args[0]);
        const owned = !sql.includes("user_id") || row?.user_id === args[1];
        return { meta: { changes: row && owned && table.delete(args[0]) ? 1 : 0 } };
      }
      return { meta: { changes: 1 } };
    },
    first: async () => {
      assert.match(sql, /WHERE id = \? AND user_id = \?$/);
      const row = table.get(args[0]);
      return row?.user_id === args[1] ? row : null;
    },
    all: async () => {
      if (sql.includes("WHERE user_id")) {
        const mine = [...table.values()].filter((r) => r.user_id === args[0]).sort((a, b) => a.due_at - b.due_at || a.id - b.id);
        return { results: mine.slice(0, args[1]) };
      }
      assert.match(sql, /ORDER BY id LIMIT 25$/);
      const due = [...table.values()].filter((r) => r.due_at <= args[0]).sort((a, b) => a.id - b.id);
      return { results: due.slice(0, 25) };
    },
  });
  return { table, prepare: (sql) => ({ ...stmt(sql, []), bind: (...args) => stmt(sql, args) }) };
}

/** Answer every Discord call with `respond()`, recording the channels posted to. */
function mock(respond) {
  const posted = [];
  globalThis.fetch = async (url) => {
    const channel = String(url).match(/channels\/([^/]+)/)[1];
    posted.push(channel);
    return respond(channel);
  };
  return posted;
}

const nowSec = () => Math.floor(Date.now() / 1000);
const reminder = (over = {}) => ({ id: 1, channel_id: "c1", user_id: "u1", message: "book it", due_at: nowSec() - 5, ...over });

test("a posted reminder is removed", async () => {
  const db = fakeDb([reminder()]);
  const posted = mock(() => Response.json({ id: "m" }));
  await postDueReminders({ DB: db });
  assert.deepEqual(posted, ["c1"]);
  assert.equal(db.table.size, 0);
});

test("a reminder that hits a Discord 5xx is kept and posted on a later run", async () => {
  const db = fakeDb([reminder()]);
  mock(() => new Response("oops", { status: 502 }));
  await postDueReminders({ DB: db });
  assert.equal(db.table.size, 1);
  const [kept] = db.table.values();
  assert.equal(kept.message, "book it");
  assert.equal(kept.due_at, reminder().due_at);

  const posted = mock(() => Response.json({ id: "m" }));
  await postDueReminders({ DB: db });
  assert.deepEqual(posted, ["c1"]);
  assert.equal(db.table.size, 0);
});

test("a reminder that hits a network error is kept", async () => {
  const db = fakeDb([reminder()]);
  globalThis.fetch = async () => {
    throw new TypeError("fetch failed");
  };
  await postDueReminders({ DB: db });
  assert.equal(db.table.size, 1);
});

test("a reminder for a deleted or forbidden channel is removed", async () => {
  const db = fakeDb([reminder({ id: 1, channel_id: "gone" }), reminder({ id: 2, channel_id: "locked" })]);
  mock((channel) => new Response("nope", { status: channel === "gone" ? 404 : 403 }));
  await postDueReminders({ DB: db });
  assert.equal(db.table.size, 0);
});

test("a reminder that keeps failing is dropped once it is over an hour late", async () => {
  const db = fakeDb([reminder({ due_at: nowSec() - 61 * 60 })]);
  mock(() => new Response("oops", { status: 503 }));
  await postDueReminders({ DB: db });
  assert.equal(db.table.size, 0);
});

test("a reminder another run already claimed is not posted twice", async () => {
  const db = fakeDb([reminder()]);
  const posted = mock(() => Response.json({ id: "m" }));
  const prepare = db.prepare;
  // Simulate an overlapping run deleting the row between our SELECT and claim.
  db.prepare = (sql) => {
    if (sql.startsWith("DELETE")) db.table.clear();
    return prepare(sql);
  };
  await postDueReminders({ DB: db });
  assert.deepEqual(posted, []);
});

test("reminders that keep failing don't hold up other due reminders", async () => {
  // 25 old reminders for a channel that keeps returning 5xx fill a whole batch,
  // followed by one for a healthy channel.
  const broken = Array.from({ length: 25 }, (_, i) => reminder({ id: i + 1, channel_id: "broken", due_at: nowSec() - 600 }));
  const db = fakeDb([...broken, reminder({ id: 26, channel_id: "ok" })]);
  const posted = mock((channel) => (channel === "ok" ? Response.json({ id: "m" }) : new Response("oops", { status: 502 })));

  await postDueReminders({ DB: db });
  assert.ok(!posted.includes("ok"));
  assert.equal(db.table.size, 26); // all 25 kept for a retry

  await postDueReminders({ DB: db });
  assert.ok(posted.includes("ok"), "the healthy reminder goes out on the next run");
  assert.equal(db.table.size, 25);
  assert.ok([...db.table.values()].every((r) => r.channel_id === "broken"));
});

const base = { application_id: "app", token: "t", guild_id: "g", channel_id: "c1", member: { user: { id: "u1" }, permissions: "0" } };
const as = (userId, i) => ({ ...i, member: { user: { id: userId }, permissions: "0" } });
const sub = (name, options = []) => ({ ...base, data: { name: "reminders", options: [{ type: 1, name, options }] } });

/** Record every Discord and AI call; the AI sets a reminder for `remindAt`. */
function mockCalls(remindAt = new Date(Date.now() + 3600_000).toISOString()) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    url = String(url);
    calls.push({ url, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : undefined });
    if (url.includes("anthropic")) {
      return Response.json({
        content: [{ type: "tool_use", name: "set_reminder", input: { remind_at: remindAt, message: "call mom", missing_info: null } }],
      });
    }
    return Response.json({ id: "m" });
  };
  return calls;
}
const replies = (calls) => calls.filter((c) => c.url.includes("/webhooks/"));

test("/reminders list shows only your pending reminders, soonest first, privately", async () => {
  const later = nowSec() + 7200;
  const soon = nowSec() + 600;
  const db = fakeDb([
    reminder({ id: 1, due_at: later, message: "later thing" }),
    reminder({ id: 2, due_at: soon, channel_id: "c2", message: "soon thing" }),
    reminder({ id: 3, user_id: "u2", due_at: soon, message: "not yours" }),
  ]);
  const calls = mockCalls();
  await reminders(sub("list"), { DB: db });
  const [reply] = replies(calls);
  assert.equal(replies(calls).length, 1);
  assert.match(reply.body.content, /\*\*#2\*\* · <#c2> · <t:\d+:f>.*\n> soon thing\n\*\*#1\*\* · <#c1> .*\n> later thing$/s);
  assert.doesNotMatch(reply.body.content, /not yours/);
  assert.deepEqual(reply.body.allowed_mentions, { parse: [] });

  const { replyFlags } = await import("../src/index.js");
  const { EPHEMERAL } = await import("../src/discord.js");
  assert.equal(await replyFlags(sub("list"), {}), EPHEMERAL);
  assert.equal(await replyFlags(sub("cancel", [{ name: "id", value: 1 }]), {}), EPHEMERAL);
});

test("/reminders list with nothing pending says how to set one", async () => {
  const calls = mockCalls();
  await reminders(sub("list"), { DB: fakeDb([reminder({ user_id: "u2" })]) });
  assert.match(replies(calls)[0].body.content, /no pending reminders/);
});

test("a long /reminders list keeps its follow-up messages private", async () => {
  const rows = Array.from({ length: 25 }, (_, i) => reminder({ id: i + 1, due_at: nowSec() + 60 * (i + 1), message: "x".repeat(400) }));
  const calls = mockCalls();
  await reminders(sub("list"), { DB: fakeDb(rows) });
  const followUps = replies(calls).filter((c) => c.method === "POST");
  assert.ok(followUps.length > 0);
  assert.ok(followUps.every((c) => c.body.flags === 1 << 6));
});

test("/reminders cancel removes your own reminder, and it no longer posts", async () => {
  const db = fakeDb([reminder({ id: 1, due_at: nowSec() + 60 }), reminder({ id: 2, due_at: nowSec() + 60, message: "keep me" })]);
  const calls = mockCalls();
  await reminders(sub("cancel", [{ name: "id", value: 1 }]), { DB: db });
  assert.match(replies(calls)[0].body.content, /Cancelled reminder \*\*#1\*\* · <#c1> .*\n> book it$/s);
  assert.deepEqual([...db.table.keys()], [2]);

  for (const r of db.table.values()) r.due_at = nowSec() - 5;
  const posted = mock(() => Response.json({ id: "m" }));
  await postDueReminders({ DB: db });
  assert.deepEqual(posted, ["c1"]);
  assert.equal(db.table.size, 0);
});

test("nobody can cancel someone else's reminder", async () => {
  const db = fakeDb([reminder({ id: 1, user_id: "u2", due_at: nowSec() + 60 })]);
  mockCalls();
  await assert.rejects(reminders(sub("cancel", [{ name: "id", value: 1 }]), { DB: db }), /couldn't find a pending reminder #1 of yours/);
  assert.equal(db.table.size, 1);
  await assert.rejects(reminders(sub("cancel", [{ name: "id", value: 99 }]), { DB: db }), /couldn't find/);
});

const remindI = as("u1", { ...base, data: { name: "remind", options: [{ name: "reminder", value: "in an hour to call mom" }] } });

test("/remind still sets a reminder as before", async () => {
  const db = fakeDb();
  const calls = mockCalls();
  await remind(remindI, { DB: db });
  const [row] = db.table.values();
  assert.deepEqual([row.channel_id, row.user_id, row.message], ["c1", "u1", "call mom"]);
  assert.match(replies(calls).at(-1).body.content, /^⏰ Got it! I'll post a reminder here <t:\d+:F> \(<t:\d+:R>\):\n> call mom$/);
});

test("a 26th pending reminder from one user is refused, others can still set theirs", async () => {
  const rows = Array.from({ length: 25 }, (_, i) => reminder({ id: i + 1, due_at: nowSec() + 60 }));
  const db = fakeDb(rows);
  const calls = mockCalls();
  await assert.rejects(remind(remindI, { DB: db }), /already have 25 reminders waiting.*\/reminders list/);
  assert.equal(db.table.size, 25);
  assert.ok(!calls.some((c) => c.url.includes("anthropic")), "refused before asking the AI");

  await remind(as("u2", remindI), { DB: db });
  assert.equal(db.table.size, 26);

  db.table.delete(1);
  await remind(remindI, { DB: db });
  assert.equal(db.table.size, 26);
});

/** A D1 stand-in for a fresh database: any query on a table that wasn't created yet fails like D1 does. */
function emptyDb() {
  const created = new Set();
  const stmt = (sql) => {
    const check = () => {
      const made = sql.match(/^CREATE TABLE IF NOT EXISTS (\w+)/);
      if (made) return created.add(made[1]);
      const used = sql.match(/(?:FROM|INTO|ON) (\w+)/)[1];
      if (!created.has(used)) throw new Error(`D1_ERROR: no such table: ${used}`);
    };
    return {
      run: async () => (check(), { meta: { changes: 0 } }),
      all: async () => (check(), { results: [] }),
      first: async () => (check(), null),
    };
  };
  return { created, prepare: (sql) => ({ ...stmt(sql), bind: () => stmt(sql) }) };
}

test("the reminder check works on a fresh database that never had migrations applied", async () => {
  const db = emptyDb();
  await postDueReminders({ DB: db });
  assert.ok(db.created.has("reminders"));
});

test("command sync works on a fresh database that never had migrations applied", async () => {
  const db = emptyDb();
  const registered = [];
  globalThis.fetch = async (url, init) => {
    registered.push(String(url));
    return Response.json(JSON.parse(init.body));
  };
  await syncCommandsIfChanged({ DB: db, DISCORD_APP_ID: "app123", DISCORD_TOKEN: "t" });
  assert.ok(db.created.has("meta"));
  assert.deepEqual(registered, ["https://discord.com/api/v10/applications/app123/commands"]);
});
