import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { postDueReminders } from "../src/commands/remind.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** A tiny in-memory stand-in for the D1 reminders table. */
function fakeDb(rows = []) {
  const table = new Map(rows.map((r) => [r.id, { created_at: 0, ...r }]));
  const stmt = (sql, args) => ({
    run: async () => {
      if (sql.startsWith("INSERT")) {
        const [id, channel_id, user_id, message, due_at, created_at] = args;
        table.set(id, { id, channel_id, user_id, message, due_at, created_at });
      } else if (sql.startsWith("DELETE")) {
        return { meta: { changes: table.delete(args[0]) ? 1 : 0 } };
      }
      return { meta: { changes: 1 } };
    },
    all: async () => ({
      results: [...table.values()].filter((r) => r.due_at <= args[0]).sort((a, b) => a.due_at - b.due_at),
    }),
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
  assert.equal(db.table.get(1).message, "book it");

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
