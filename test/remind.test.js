import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { postDueReminders } from "../src/commands/remind.js";

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
      if (sql.startsWith("INSERT")) {
        const [channel_id, user_id, message, due_at, created_at] = args;
        const id = nextId++;
        table.set(id, { id, channel_id, user_id, message, due_at, created_at });
      } else if (sql.startsWith("DELETE")) {
        return { meta: { changes: table.delete(args[0]) ? 1 : 0 } };
      }
      return { meta: { changes: 1 } };
    },
    all: async () => {
      assert.match(sql, /ORDER BY id LIMIT 25$/);
      const due = [...table.values()].filter((r) => r.due_at <= args[0]).sort((a, b) => a.id - b.id);
      return { results: due.slice(0, 25) };
    },
  });
  return { table, prepare: (sql) => ({ bind: (...args) => stmt(sql, args) }) };
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
