import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { birthday, birthdaysOn, formatBirthday, parseBirthday, postDueBirthdays } from "../src/commands/birthday.js";
import { catchup, isForUser, messagesSince } from "../src/commands/catchup.js";
import { replyFlags } from "../src/index.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const READ = String((1n << 10n) | (1n << 16n));
const MANAGE = String(1n << 4n);
const EPHEMERAL = 1 << 6;

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
const lastEdit = (calls) => calls.filter((c) => c.url.endsWith("/messages/@original")).at(-1)?.body;

// --- /catchup ---

const iso = (minutesAgo) => new Date(Date.now() - minutesAgo * 60000).toISOString();
const msg = (id, who, content, minutesAgo, extra = {}) => ({
  id,
  content,
  timestamp: iso(minutesAgo),
  author: { id: who, username: who },
  ...extra,
});

// Newest first, the way Discord returns it.
const HISTORY = [
  msg("6", "jo", "see you all friday", 5),
  msg("5", "sunny", "<@me> are you driving?", 10, { mentions: [{ id: "me" }] }),
  msg("4", "jo", "tacos at 7 then", 20),
  msg("3", "sunny", "who's in for tacos friday?", 30),
  msg("2", "me", "ok heading out", 120),
  msg("1", "jo", "old stuff", 500),
];

test("catches up from the user's last message, or the last day if they haven't posted", () => {
  const { messages, sinceOwnMessage } = messagesSince(HISTORY, "me");
  assert.ok(sinceOwnMessage);
  assert.deepEqual(messages.map((m) => m.id), ["3", "4", "5", "6"], "oldest first, after their last message");

  const quiet = messagesSince(HISTORY, "stranger");
  assert.equal(quiet.sinceOwnMessage, false);
  assert.deepEqual(quiet.messages.map((m) => m.id), ["1", "2", "3", "4", "5", "6"], "everything from the last 24 hours");
  const withOld = [...HISTORY, msg("0", "jo", "two days ago", 60 * 48)];
  assert.ok(!messagesSince(withOld, "stranger").messages.some((m) => m.id === "0"), "nothing older than 24 hours");
});

test("recognizes mentions and replies to the user", () => {
  assert.ok(isForUser(HISTORY[1], "me"));
  assert.ok(isForUser(msg("x", "jo", "yes", 1, { referenced_message: { author: { id: "me" } } }), "me"));
  assert.ok(!isForUser(HISTORY[0], "me"));
});

test("/catchup summarizes and lists what's for you, without pinging", async () => {
  let prompt;
  const calls = mock([
    ["anthropic", (_u, body) => {
      prompt = body.messages[0].content;
      return { content: [{ type: "tool_use", name: "catch_up", input: { summary: "Tacos Friday at 7 is the plan.", for_you: [0] } }] };
    }],
    ["/channels/general/messages", () => HISTORY],
  ]);
  await catchup(
    {
      application_id: "app",
      token: "t",
      channel_id: "general",
      guild_id: "g",
      member: { user: { id: "me", username: "ashar" }, nick: "Ashar" },
      data: { name: "catchup", options: [] },
    },
    {},
  );
  assert.match(prompt, /since Ashar was last here/);
  assert.doesNotMatch(prompt, /ok heading out|old stuff/);
  const out = lastEdit(calls);
  assert.match(out.content, /^🧭 \*\*Catch-up\*\* · this channel · 4 messages since your last message <t:\d+:R>\nTacos Friday at 7 is the plan\./);
  assert.match(out.content, /\*\*For you:\*\*\n• sunny: "who's in for tacos friday\?" .*\/3\n• sunny: "<@me> are you driving\?" .*\/5/);
  assert.deepEqual(out.allowed_mentions, { parse: [] });
});

test("/catchup says when there's nothing new", async () => {
  const calls = mock([
    ["anthropic", () => assert.fail("no AI call")],
    ["/channels/general/messages", () => [msg("9", "me", "hi", 1)]],
  ]);
  await catchup(
    { application_id: "app", token: "t", channel_id: "general", member: { user: { id: "me" } }, data: { name: "catchup", options: [] } },
    {},
  );
  assert.match(lastEdit(calls).content, /You're all caught up in this channel: nothing new since your last message/);
});

test("/catchup is private by default, public on request, and private for private channels", async () => {
  const base = { channel_id: "bot", guild_id: "g", member: { user: { id: "me" } } };
  assert.equal(await replyFlags({ ...base, data: { name: "catchup", options: [] } }, {}), EPHEMERAL);
  assert.equal(await replyFlags({ ...base, data: { name: "catchup", options: [{ name: "public", value: true }] } }, {}), undefined);

  mock([
    ["/guilds/g", () => ({ id: "g", roles: [{ id: "g", permissions: READ }] })],
    ["/channels/staff", () => ({ id: "staff", permission_overwrites: [{ id: "g", type: 0, allow: "0", deny: String(1n << 10n) }] })],
  ]);
  const privateSource = {
    ...base,
    data: { name: "catchup", options: [{ name: "public", value: true }, { name: "channel", value: "staff" }] },
  };
  assert.equal(await replyFlags(privateSource, {}), EPHEMERAL, "a private channel's catch-up never posts publicly");
});

// --- /birthday ---

test("parses birthdays in common formats", () => {
  assert.deepEqual(parseBirthday("9/27"), { month: 9, day: 27 });
  assert.deepEqual(parseBirthday("09-27"), { month: 9, day: 27 });
  assert.deepEqual(parseBirthday("Sep 27"), { month: 9, day: 27 });
  assert.deepEqual(parseBirthday("September 27th"), { month: 9, day: 27 });
  assert.deepEqual(parseBirthday("27 sept"), { month: 9, day: 27 });
  assert.deepEqual(parseBirthday("2/29"), { month: 2, day: 29 });
  assert.throws(() => parseBirthday("2/30"), /couldn't read "2\/30"/);
  assert.throws(() => parseBirthday("someday"), /couldn't read/);
  assert.equal(formatBirthday({ month: 9, day: 27 }), "Sep 27");
});

test("Feb 29 birthdays are celebrated on Feb 28 in non-leap years", () => {
  const rows = [{ user_id: "leap", month: 2, day: 29 }, { user_id: "a", month: 2, day: 28 }];
  assert.deepEqual(birthdaysOn(rows, "2027-02-28").map((r) => r.user_id), ["leap", "a"]);
  assert.deepEqual(birthdaysOn(rows, "2028-02-28").map((r) => r.user_id), ["a"]);
  assert.deepEqual(birthdaysOn(rows, "2028-02-29").map((r) => r.user_id), ["leap"]);
});

function fakeDb() {
  const birthdays = new Map();
  const settings = new Map();
  const stmt = (sql, args = []) => ({
    run: async () => {
      if (sql.startsWith("INSERT INTO birthdays (")) {
        const [guild_id, user_id, name, month, day] = args;
        birthdays.set(`${guild_id}:${user_id}`, { guild_id, user_id, name, month, day });
      } else if (sql.startsWith("INSERT INTO birthday_settings")) {
        const [guild_id, channel_id, hour, minute, last_sent] = args;
        settings.set(guild_id, { guild_id, channel_id, hour, minute, last_sent });
      } else if (sql.startsWith("UPDATE birthday_settings")) {
        settings.get(args[1]).last_sent = args[0];
      } else if (sql.startsWith("DELETE FROM birthdays")) {
        return { meta: { changes: birthdays.delete(`${args[0]}:${args[1]}`) ? 1 : 0 } };
      }
      return { meta: { changes: 1 } };
    },
    all: async () => ({
      results: sql.includes("birthday_settings")
        ? [...settings.values()]
        : [...birthdays.values()].filter((b) => !args[0] || b.guild_id === args[0]),
    }),
    first: async () => (sql.includes("birthday_settings") ? settings.get(args[0]) ?? null : null),
  });
  return { birthdays, settings, prepare: (sql) => ({ ...stmt(sql), bind: (...args) => stmt(sql, args) }) };
}

const bday = (sub, options = [], perms = "0", extra = {}) => ({
  application_id: "app",
  token: "t",
  channel_id: "general",
  guild_id: "g",
  member: { user: { id: "me", username: "ashar" }, nick: "Ashar", permissions: perms },
  data: { name: "birthday", options: [{ type: 1, name: sub, options }], ...extra },
});

test("anyone can set their own birthday; setting others and the channel needs Manage Channels", async () => {
  const db = fakeDb();
  const env = { DB: db, TIMEZONE: "America/New_York" };
  let calls = mock([]);
  await birthday(bday("set", [{ name: "date", value: "Sep 27" }]), env);
  assert.deepEqual({ ...db.birthdays.get("g:me") }, { guild_id: "g", user_id: "me", name: "Ashar", month: 9, day: 27 });
  assert.match(lastEdit(calls).content, /Saved your birthday as \*\*Sep 27\*\*\.\n⚠️ No birthday channel yet/);

  await assert.rejects(
    birthday(bday("set", [{ name: "date", value: "1/2" }, { name: "user", value: "sunny" }]), env),
    /You can only change your own birthday/,
  );
  await assert.rejects(birthday(bday("channel", []), env), /Only people who can manage channels/);

  calls = mock([]);
  await birthday(
    bday("set", [{ name: "date", value: "1/2" }, { name: "user", value: "sunny" }], MANAGE, {
      resolved: { users: { sunny: { id: "sunny", username: "sunny" } } },
    }),
    env,
  );
  assert.equal(db.birthdays.get("g:sunny").month, 1);
  await birthday(bday("channel", [{ name: "channel", value: "party" }, { name: "time", value: "9am" }], MANAGE), env);
  assert.equal(db.settings.get("g").channel_id, "party");
  assert.match(lastEdit(calls).content, /Birthday wishes will go in <#party> at \*\*9am\*\*/);
});

test("/birthday list shows upcoming birthdays without pinging", async () => {
  const db = fakeDb();
  db.birthdays.set("g:a", { guild_id: "g", user_id: "a", month: 12, day: 25 });
  db.birthdays.set("g:b", { guild_id: "g", user_id: "b", month: 1, day: 1 });
  const calls = mock([]);
  await birthday(bday("list"), { DB: db, TIMEZONE: "America/New_York" });
  const out = lastEdit(calls);
  assert.match(out.content, /🎂 \*\*Upcoming birthdays\*\*/);
  assert.ok(out.content.indexOf("<@a>") < out.content.indexOf("<@b>"), "Dec 25 comes before Jan 1 from mid-November");
  assert.deepEqual(out.allowed_mentions, { parse: [] });
});

test("on the day, wishes post once and ping only the birthday people", async () => {
  const db = fakeDb();
  db.settings.set("g", { guild_id: "g", channel_id: "party", hour: 9, minute: 0, last_sent: null });
  db.birthdays.set("g:sunny", { guild_id: "g", user_id: "sunny", name: "Sunny", month: 11, day: 17 });
  db.birthdays.set("g:jo", { guild_id: "g", user_id: "jo", name: "Jo", month: 11, day: 17 });
  db.birthdays.set("g:x", { guild_id: "g", user_id: "x", name: "X", month: 3, day: 1 });
  let prompt;
  const calls = mock([["anthropic", (_u, body) => {
    prompt = body.messages[0].content;
    return { content: [{ type: "tool_use", name: "wish", input: { wish: "May your trains always be on time 🚆" } }] };
  }]]);
  const now = { date: "2026-11-17", day: 17, weekday: 2, minutes: 9 * 60 + 3 };

  assert.equal(await postDueBirthdays({ DB: db }, { now }), 1);
  assert.match(prompt, /2 friends \(Sunny, Jo\)/);
  const post = calls.find((c) => c.method === "POST" && c.url.endsWith("/channels/party/messages"));
  assert.equal(post.body.content, "🎂 Happy birthday <@sunny> and <@jo>! May your trains always be on time 🚆");
  assert.deepEqual(post.body.allowed_mentions, { parse: [], users: ["sunny", "jo"] });
  assert.equal(await postDueBirthdays({ DB: db }, { now }), 0, "only once a day");
});

test("no birthdays today means no post", async () => {
  const db = fakeDb();
  db.settings.set("g", { guild_id: "g", channel_id: "party", hour: 9, minute: 0, last_sent: null });
  db.birthdays.set("g:x", { guild_id: "g", user_id: "x", month: 3, day: 1 });
  const calls = mock([["anthropic", () => assert.fail("no AI call")]]);
  await postDueBirthdays({ DB: db }, { now: { date: "2026-11-17", day: 17, weekday: 2, minutes: 600 } });
  assert.ok(!calls.some((c) => c.method === "POST"));
});
