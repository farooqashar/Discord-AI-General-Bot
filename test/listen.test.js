import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { isForBot, listen, pollMentions } from "../src/commands/listen.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const BOT = "bot";

/** A tiny in-memory stand-in for the D1 watched_channels table. */
function fakeDb(rows = []) {
  const table = new Map(rows.map((r) => [r.channel_id, { ...r }]));
  return {
    table,
    prepare: (sql) => ({
      bind: (...args) => stmt(sql, args),
      ...stmt(sql, []),
    }),
  };
  function stmt(sql, args) {
    return {
      run: async () => {
        if (sql.startsWith("INSERT")) {
          const [channel_id, guild_id, last_seen_id, added_by] = args;
          table.set(channel_id, { channel_id, guild_id, last_seen_id, added_by });
        } else if (sql.startsWith("UPDATE")) {
          table.get(args[1]).last_seen_id = args[0];
        } else if (sql.startsWith("DELETE")) {
          table.delete(args[0]);
        }
      },
      all: async () => ({ results: [...table.values()] }),
    };
  }
}

function mock(handlers) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    url = String(url);
    calls.push({ url, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : undefined });
    for (const [match, respond] of handlers) {
      if (url.includes(match)) {
        const out = respond(url, init);
        return out instanceof Response ? out : Response.json(out);
      }
    }
    return Response.json({ id: "sent" });
  };
  return calls;
}

const msg = (id, content, extra = {}) => ({
  id,
  content,
  author: { id: "u1", username: "sunny" },
  ...extra,
});

test("recognizes @mentions and replies to the bot, but not bots or other mentions", () => {
  assert.ok(isForBot(msg("1", `<@${BOT}> hi`, { mentions: [{ id: BOT }] }), BOT));
  assert.ok(isForBot(msg("1", `hey <@!${BOT}>`), BOT));
  assert.ok(isForBot(msg("1", "lol yes", { referenced_message: { author: { id: BOT } } }), BOT));
  assert.ok(!isForBot(msg("1", "<@someone-else> hi", { mentions: [{ id: "someone-else" }] }), BOT));
  assert.ok(!isForBot(msg("1", `<@${BOT}> hi`, { author: { id: "other-bot", bot: true } }), BOT));
  assert.ok(!isForBot(msg("1", "just chatting"), BOT));
});

test("answers new mentions as a reply, with recent chat as context, and claims them first", async () => {
  const db = fakeDb([{ channel_id: "c1", last_seen_id: "100" }]);
  let prompt;
  let claimedBeforeAnswer;
  const calls = mock([
    ["anthropic", (_u, init) => {
      claimedBeforeAnswer = db.table.get("c1").last_seen_id;
      prompt = JSON.parse(init.body).messages[0].content;
      return { content: [{ type: "text", text: "Joe's Shanghai, get the soup dumplings." }] };
    }],
    ["messages?limit=50&after=100", () => [
      msg("103", "anyway"),
      msg("102", `<@${BOT}> where should we eat?`, { mentions: [{ id: BOT }] }),
      msg("101", "we're in chinatown"),
    ]],
    ["before=102", () => [msg("101", "we're in chinatown"), msg("99", "hungry")]],
  ]);

  await pollMentions({ DB: db, DISCORD_APP_ID: BOT });

  assert.equal(claimedBeforeAnswer, "103", "claimed the newest message before answering");
  assert.equal(db.table.get("c1").last_seen_id, "103");
  assert.match(prompt, /Recent chat:\nsunny: hungry\nsunny: we're in chinatown/);
  assert.match(prompt, /Latest message, from sunny: where should we eat\?$/);
  assert.ok(calls.some((c) => c.url.endsWith("/channels/c1/typing")), "shows typing");

  const sent = calls.filter((c) => c.url.endsWith("/channels/c1/messages") && c.method === "POST");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.content, "Joe's Shanghai, get the soup dumplings.");
  assert.deepEqual(sent[0].body.message_reference, { message_id: "102", fail_if_not_exists: false });
  assert.deepEqual(sent[0].body.allowed_mentions, { parse: [], replied_user: true });
});

test("does nothing when there are no new messages or no mentions", async () => {
  const db = fakeDb([{ channel_id: "c1", last_seen_id: "100" }]);
  const calls = mock([
    ["anthropic", () => assert.fail("no AI call")],
    ["after=100", () => [msg("101", "just chatting")]],
  ]);
  await pollMentions({ DB: db, DISCORD_APP_ID: BOT });
  assert.equal(db.table.get("c1").last_seen_id, "101");
  assert.ok(!calls.some((c) => c.method === "POST"));
});

test("caps replies per channel per run", async () => {
  const db = fakeDb([{ channel_id: "c1", last_seen_id: "100" }]);
  const many = Array.from({ length: 8 }, (_, i) => msg(String(110 - i), `<@${BOT}> q${i}`, { mentions: [{ id: BOT }] }));
  let aiCalls = 0;
  mock([
    ["anthropic", () => {
      aiCalls++;
      return { content: [{ type: "text", text: "ok" }] };
    }],
    ["after=100", () => many],
    ["before=", () => []],
  ]);
  await pollMentions({ DB: db, DISCORD_APP_ID: BOT });
  assert.equal(aiCalls, 5);
});

test("stops watching a channel the bot lost access to", async () => {
  const db = fakeDb([{ channel_id: "gone", last_seen_id: "1" }]);
  mock([["/channels/gone/messages", () => new Response("{}", { status: 404 })]]);
  const warn = console.warn;
  console.warn = () => {};
  try {
    await pollMentions({ DB: db, DISCORD_APP_ID: BOT });
  } finally {
    console.warn = warn;
  }
  assert.ok(!db.table.has("gone"));
});

const interaction = (action, permissions) => ({
  application_id: BOT,
  token: "tok",
  channel_id: "c1",
  guild_id: "g1",
  member: { user: { id: "u1" }, permissions },
  data: { name: "listen", options: action ? [{ name: "action", value: action }] : [] },
});

test("/listen on starts from the newest message so old mentions are ignored", async () => {
  const db = fakeDb();
  const calls = mock([["/channels/c1/messages?limit=1", () => [{ id: "555" }]]]);
  await listen(interaction("on", String(1n << 4n)), { DB: db });
  assert.equal(db.table.get("c1").last_seen_id, "555");
  assert.match(calls.at(-1).body.content, /I'm listening here now/);
});

test("/listen on and off need channel-management permission; status doesn't", async () => {
  const db = fakeDb([{ channel_id: "c1", guild_id: "g1", last_seen_id: "1" }]);
  mock([]);
  await assert.rejects(listen(interaction("off", "0"), { DB: db }), /Only people who can manage channels/);
  assert.ok(db.table.has("c1"));

  const calls = mock([]);
  await listen(interaction(null, "0"), { DB: db });
  assert.match(calls.at(-1).body.content, /I answer @mentions in: <#c1>/);

  await listen(interaction("off", String(1n << 3n)), { DB: db });
  assert.ok(!db.table.has("c1"));
});
