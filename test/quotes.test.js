import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { detectQuote, extractQuotes, formatQuote, quotes, syncQuoteBook } from "../src/commands/quotes.js";
import { finishLogin, safeNext, startLogin } from "../src/web/auth.js";
import { dailyIndex, escapeHtml, handleWeb } from "../src/web/quotes-site.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const READ = String((1n << 10n) | (1n << 16n));
const MANAGE = String((1n << 4n) | (1n << 10n) | (1n << 16n));

function mock(handlers) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    url = String(url);
    calls.push({ url, method: init.method ?? "GET", body: init.body, headers: init.headers });
    for (const [match, respond] of handlers) {
      if (url.includes(match)) {
        const out = await respond(url, init);
        return out instanceof Response ? out : Response.json(out);
      }
    }
    return Response.json({ id: "sent" });
  };
  return calls;
}

/** A tiny in-memory D1 that understands the Quote Book's queries. */
function fakeDb() {
  const books = new Map();
  const quotesT = new Map();
  const sessions = new Map();
  const stmt = (sql, args = []) => ({
    async run() {
      if (sql.startsWith("CREATE") || sql.startsWith("DELETE FROM web_sessions WHERE expires_at")) return {};
      if (sql.startsWith("INSERT INTO quote_books")) {
        const [guild_id, guild_name, channel_id, last_message_id] = args;
        books.set(guild_id, { guild_id, guild_name, channel_id, last_message_id });
      } else if (sql.startsWith("UPDATE quote_books SET last_message_id")) {
        books.get(args[1]).last_message_id = args[0];
      } else if (sql.startsWith("INSERT OR IGNORE INTO quotes")) {
        const [message_id, guild_id, channel_id, text, speaker, speaker_id, poster_id, poster_name, posted_at, stars, reactions, pinned] = args;
        if (!quotesT.has(message_id)) {
          quotesT.set(message_id, { message_id, guild_id, channel_id, text, speaker, speaker_id, poster_id, poster_name, posted_at, stars, reactions, pinned });
        }
      } else if (sql.startsWith("UPDATE quotes SET stars")) {
        Object.assign(quotesT.get(args[3]), { stars: args[0], reactions: args[1], pinned: args[2] });
      } else if (sql.startsWith("INSERT INTO web_sessions")) {
        const [token, user_id, username, guild_ids, expires_at] = args;
        sessions.set(token, { token, user_id, username, guild_ids, expires_at });
      } else if (sql.startsWith("DELETE FROM quote_books")) books.delete(args[0]);
      return { meta: { changes: 1 } };
    },
    async all() {
      if (sql.startsWith("SELECT message_id, stars")) return { results: args.map((id) => quotesT.get(id)).filter(Boolean) };
      if (sql.includes("FROM quote_books")) return { results: [...books.values()] };
      if (sql.includes("COUNT(*) AS n FROM quotes") && !sql.includes("GROUP BY")) return { results: [{ n: [...quotesT.values()].filter((q) => q.guild_id === args[0]).length }] };
      if (sql.includes("GROUP BY")) return { results: [] };
      return { results: [...quotesT.values()].filter((q) => q.guild_id === args[0]) };
    },
    async first() {
      if (sql.includes("FROM web_sessions")) return sessions.get(args[0]) ?? null;
      if (sql.includes("FROM quote_books")) return books.get(args[0]) ?? null;
      const rows = [...quotesT.values()].filter((q) => q.guild_id === args[0]);
      return rows[0] ?? null;
    },
  });
  return { books, quotes: quotesT, sessions, prepare: (sql) => ({ ...stmt(sql), bind: (...args) => stmt(sql, args) }) };
}

const msg = (id, content, extra = {}) => ({
  id,
  content,
  timestamp: new Date(Date.now() - Number(id) * 1000).toISOString(),
  author: { id: "u1", username: "ashar" },
  ...extra,
});

// --- detection ---

test("detects the common quote formats and ignores chatter", () => {
  assert.deepEqual(detectQuote('"I\'m not lost, the LIRR is" - Ashar'), { text: "I'm not lost, the LIRR is", speaker: "Ashar", speakerId: null });
  assert.deepEqual(detectQuote("“Never trust a deli without a cat” — <@42>"), { text: "Never trust a deli without a cat", speaker: "<@42>", speakerId: "42" });
  assert.deepEqual(detectQuote('Sunny: "i eat around vegetables"'), { text: "i eat around vegetables", speaker: "Sunny", speakerId: null });
  assert.deepEqual(detectQuote('"just vibes"'), { text: "just vibes", speaker: null, speakerId: null });
  assert.equal(detectQuote("lol what time is it"), null);
  assert.equal(detectQuote('"quoted" and then a long story that keeps going and going and going for a while'), null);
});

test("messier quotes go to the AI; bots and slash commands are skipped", async () => {
  let prompt;
  mock([["anthropic", (_u, init) => {
    prompt = JSON.parse(init.body).messages[0].content;
    return { content: [{ type: "tool_use", name: "save_quotes", input: { quotes: [{ index: 0, text: "i only eat beige food", speaker: "Jo" }] } }] };
  }]]);
  const { found, failed } = await extractQuotes({}, [
    msg("1", '"clean one" - Ashar'),
    msg("2", "jo at dinner tonight: i only eat beige food"),
    msg("3", "bot stuff", { author: { id: "b", bot: true } }),
    msg("4", "/quotes random"),
  ]);
  assert.doesNotMatch(prompt, /clean one|bot stuff|\/quotes/);
  assert.deepEqual(found.map((f) => [f.message.id, f.quote.text, f.quote.speaker]), [
    ["1", "clean one", "Ashar"],
    ["2", "i only eat beige food", "Jo"],
  ]);
  assert.deepEqual(failed, []);
});

// --- syncing ---

test("sync saves new quotes, refreshes stars, and pins at 3 ⭐", async () => {
  const db = fakeDb();
  db.books.set("g", { guild_id: "g", channel_id: "q", last_message_id: "10" });
  db.quotes.set("9", { message_id: "9", guild_id: "g", channel_id: "q", text: "old one", stars: 1, reactions: 1, pinned: 0 });
  const calls = mock([
    ["/channels/q/messages/pins/", () => new Response(null, { status: 204 })],
    ["/channels/q/messages?limit=100", () => [
      msg("12", '"brand new" - Sunny'),
      msg("11", "just chatting", {}),
      msg("9", '"old one" - Jo', { reactions: [{ count: 3, emoji: { name: "⭐" } }] }),
    ]],
    ["anthropic", () => ({ content: [{ type: "tool_use", name: "save_quotes", input: { quotes: [] } }] })],
  ]);
  const out = await syncQuoteBook({ DB: db }, db.books.get("g"));
  assert.equal(out.added, 1);
  assert.equal(db.quotes.get("12").text, "brand new");
  assert.equal(db.books.get("g").last_message_id, "12");
  assert.deepEqual({ stars: db.quotes.get("9").stars, pinned: db.quotes.get("9").pinned }, { stars: 3, pinned: 1 });
  assert.ok(calls.some((c) => c.method === "PUT" && c.url.endsWith("/channels/q/messages/pins/9")));
  assert.ok(!calls.some((c) => c.method === "PUT" && c.url.endsWith("/pins/12")), "new quote without stars isn't pinned");
});

test("sync retries messages the AI couldn't check once it works again", async () => {
  const db = fakeDb();
  db.books.set("g", { guild_id: "g", channel_id: "q", last_message_id: "10" });
  let aiDown = true;
  let aiPrompt;
  mock([
    ["/channels/q/messages?limit=100", () => [
      msg("13", '"clean one" - Sunny'),
      msg("12", "Jo said she only eats beige food"),
      msg("11", "just chatting"),
    ]],
    ["anthropic", (_u, init) => {
      if (aiDown) return new Response("overloaded", { status: 500 });
      aiPrompt = JSON.parse(init.body).messages[0].content;
      const index = aiPrompt.split("\n").findIndex((line) => line.includes("beige food"));
      return { content: [{ type: "tool_use", name: "save_quotes", input: { quotes: [{ index, text: "she only eats beige food", speaker: "Jo" }] } }] };
    }],
  ]);

  await syncQuoteBook({ DB: db }, db.books.get("g"));
  assert.equal(db.quotes.get("13").text, "clean one", "pattern matches are saved right away");
  assert.ok(!db.quotes.has("12"));
  assert.equal(db.books.get("g").last_message_id, "10", "the cursor stops before the messages the AI missed");

  aiDown = false;
  await syncQuoteBook({ DB: db }, db.books.get("g"));
  assert.equal(db.quotes.get("12").text, "she only eats beige food");
  assert.equal(db.quotes.size, 2);
  assert.equal(db.books.get("g").last_message_id, "13");
  assert.doesNotMatch(aiPrompt, /clean one/);
});

test("sync hands the messages back if saving fails", async () => {
  const db = fakeDb();
  db.books.set("g", { guild_id: "g", channel_id: "q", last_message_id: "10" });
  mock([["/channels/q/messages?limit=100", () => [msg("12", '"brand new" - Sunny')]]]);
  const prepare = db.prepare;
  db.prepare = (sql) => (sql.startsWith("INSERT OR IGNORE INTO quotes") ? assert.fail("D1 is down") : prepare(sql));
  await assert.rejects(syncQuoteBook({ DB: db }, db.books.get("g")), /D1 is down/);
  assert.equal(db.books.get("g").last_message_id, "10");
});

test("/quotes setup needs a public channel and imports history", async () => {
  const db = fakeDb();
  const base = { application_id: "app", token: "t", channel_id: "q", guild_id: "g", member: { user: { id: "me" }, permissions: MANAGE } };
  const setup = (channel) => ({ ...base, data: { name: "quotes", options: [{ type: 1, name: "setup", options: [{ name: "channel", value: channel }] }] } });
  const calls = mock([
    ["/guilds/g", () => ({ id: "g", name: "MIT friends", roles: [{ id: "g", permissions: READ }] })],
    ["/channels/staff/messages", () => assert.fail("never reads a private channel")],
    ["/channels/staff", () => ({ id: "staff", permission_overwrites: [{ id: "g", type: 0, allow: "0", deny: String(1n << 10n) }] })],
    ["/channels/q/messages", () => [msg("2", '"two" - Jo'), msg("1", '"one" - Sunny')]],
    ["/channels/q", () => ({ id: "q", permission_overwrites: [] })],
  ]);
  await assert.rejects(quotes(setup("staff"), { DB: db }), /needs a channel everyone in the server can see/);
  await quotes(setup("q"), { DB: db, PUBLIC_URL: "https://bot.example" });
  assert.equal(db.quotes.size, 2);
  assert.equal(db.books.get("g").guild_name, "MIT friends");
  const reply = calls.filter((c) => c.url.endsWith("/messages/@original")).at(-1);
  assert.match(JSON.parse(reply.body).content, /saved \*\*2\*\* quotes .*\nBrowse them: https:\/\/bot\.example\/quotes\/g/s);

  await assert.rejects(
    quotes({ ...setup("q"), member: { user: { id: "x" }, permissions: READ } }, { DB: db }),
    /Only people who can manage channels/,
  );
});

test("formats a quote for Discord with a link and no pings", () => {
  const line = formatQuote({ guild_id: "g", channel_id: "q", message_id: "5", text: "hi", speaker: "Jo", speaker_id: null, posted_at: Date.UTC(2026, 10, 1, 15), stars: 4 });
  assert.equal(line, '💬 "hi" — Jo, Nov 1, 2026 ⭐ 4\nhttps://discord.com/channels/g/q/5');
});

test("dates a late-evening quote by the day it was posted in TIMEZONE, not UTC", () => {
  // 10:30pm Nov 21 in New York is 3:30am Nov 22 UTC.
  const q = { guild_id: "g", channel_id: "q", message_id: "5", text: "hi", speaker: "Jo", posted_at: Date.UTC(2026, 10, 22, 3, 30), stars: 0 };
  assert.match(formatQuote(q), /Jo, Nov 21, 2026\n/);
  assert.match(formatQuote(q, "America/New_York"), /Jo, Nov 21, 2026\n/);
  assert.match(formatQuote(q, "Europe/London"), /Jo, Nov 22, 2026\n/);
});

// --- sign-in and the website ---

test("only redirects back to our own Quote Book pages after sign-in", () => {
  assert.equal(safeNext("/quotes/123456789"), "/quotes/123456789");
  assert.equal(safeNext("/quotes/123456789?q=tacos"), "/quotes/123456789?q=tacos");
  assert.equal(safeNext("https://evil.example"), "/quotes");
  assert.equal(safeNext("//evil.example/quotes"), "/quotes");
  assert.equal(safeNext("/auth/logout"), "/quotes");
});

test("sign-in sends people to Discord with a state cookie", () => {
  const res = startLogin(new Request("https://bot.example/auth/login?next=/quotes/123456789"), {
    DISCORD_APP_ID: "app",
    DISCORD_CLIENT_SECRET: "secret",
  });
  assert.equal(res.status, 302);
  const to = new URL(res.headers.get("Location"));
  assert.equal(to.origin + to.pathname, "https://discord.com/oauth2/authorize");
  assert.equal(to.searchParams.get("scope"), "identify guilds");
  assert.equal(to.searchParams.get("redirect_uri"), "https://bot.example/auth/callback");
  const state = to.searchParams.get("state");
  assert.match(res.headers.get("Set-Cookie"), new RegExp(`^qb_state=${encodeURIComponent(state).replace(/[.%]/g, "\\$&")}; Path=/; HttpOnly; Secure; SameSite=Lax`));
  assert.ok(!to.searchParams.has("client_secret"), "the secret never goes to the browser");
});

test("the callback rejects a mismatched state and signs in a valid one", async () => {
  const db = fakeDb();
  const env = { DB: db, DISCORD_APP_ID: "app", DISCORD_CLIENT_SECRET: "secret" };
  const bad = await finishLogin(
    new Request("https://bot.example/auth/callback?code=c&state=aaa.x", { headers: { Cookie: "qb_state=bbb.x" } }),
    env,
  );
  assert.equal(bad.status, 400);

  const calls = mock([
    ["/oauth2/token", () => ({ access_token: "tok" })],
    ["/users/@me/guilds", () => [{ id: "123456789" }, { id: "987654321" }]],
    ["/users/@me", () => ({ id: "u1", username: "ashar", global_name: "Ashar" })],
  ]);
  const state = `abc.${encodeURIComponent("/quotes/123456789")}`;
  const res = await finishLogin(
    new Request(`https://bot.example/auth/callback?code=c&state=${encodeURIComponent(state)}`, { headers: { Cookie: `qb_state=${encodeURIComponent(state)}` } }),
    env,
  );
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("Location"), "/quotes/123456789");
  const tokenCall = calls.find((c) => c.url.endsWith("/oauth2/token"));
  assert.match(String(tokenCall.body), /client_secret=secret/);
  const [session] = [...db.sessions.values()];
  assert.equal(session.user_id, "u1");
  assert.deepEqual(JSON.parse(session.guild_ids), ["123456789", "987654321"]);
  assert.ok(!Object.values(session).includes("tok"), "Discord's access token isn't stored");
  assert.match(res.headers.get("Set-Cookie"), /qb_session=[0-9a-f]{64}; Path=\/; HttpOnly; Secure; SameSite=Lax/);
});

function signedIn(db, guildIds) {
  const token = "a".repeat(64);
  db.sessions.set(token, { token, user_id: "u1", username: "Ashar", guild_ids: JSON.stringify(guildIds), expires_at: Date.now() + 60000 });
  return { headers: { Cookie: `qb_session=${token}` } };
}

test("the site shows a sign-in page, blocks non-members, and shows members the quotes", async () => {
  const db = fakeDb();
  db.books.set("123456789", { guild_id: "123456789", guild_name: "MIT friends", channel_id: "q" });
  db.quotes.set("5", { message_id: "5", guild_id: "123456789", channel_id: "q", text: "I'm not lost, the LIRR is", speaker: "Ashar", posted_at: Date.now(), stars: 4, reactions: 4 });

  const anon = await handleWeb(new Request("https://bot.example/quotes/123456789"), { DB: db });
  const anonHtml = await anon.text();
  assert.match(anonHtml, /Sign in with Discord/);
  assert.match(anonHtml, /href="\/auth\/login\?next=%2Fquotes%2F123456789"/);
  assert.doesNotMatch(anonHtml, /LIRR/, "no quotes before signing in");

  const outsider = await handleWeb(new Request("https://bot.example/quotes/123456789", signedIn(db, ["999"])), { DB: db });
  assert.equal(outsider.status, 403);
  assert.doesNotMatch(await outsider.text(), /LIRR/);

  const member = await handleWeb(new Request("https://bot.example/quotes/123456789", signedIn(db, ["123456789"])), { DB: db });
  assert.equal(member.status, 200);
  const page = await member.text();
  assert.match(page, /I&#39;m not lost, the LIRR is/);
  assert.match(page, /Quote Book <span>MIT friends<\/span>/);
  assert.match(member.headers.get("Content-Security-Policy"), /default-src 'none'/);
  assert.doesNotMatch(page, /<script/i, "no JavaScript on the page");
});

test("everything shown on the page is escaped", async () => {
  assert.equal(escapeHtml(`<img src=x onerror="alert(1)">'&`), "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&#39;&amp;");
  const db = fakeDb();
  db.books.set("123456789", { guild_id: "123456789", guild_name: "<b>srv</b>", channel_id: "q" });
  db.quotes.set("5", { message_id: "5", guild_id: "123456789", channel_id: "q", text: "<script>alert(1)</script>", speaker: '"><img src=x>', posted_at: Date.now(), stars: 0 });
  const res = await handleWeb(new Request('https://bot.example/quotes/123456789?q="><script>', signedIn(db, ["123456789"])), { DB: db });
  const page = await res.text();
  assert.doesNotMatch(page, /<script|<img src=x|<b>srv/);
});

test("the site dates quotes and rolls the quote of the day over in TIMEZONE", async () => {
  const db = fakeDb();
  db.books.set("123456789", { guild_id: "123456789", guild_name: "MIT friends", channel_id: "q" });
  // 10:30pm Nov 21 in Los Angeles is Nov 22 in New York and UTC.
  db.quotes.set("5", { message_id: "5", guild_id: "123456789", channel_id: "q", text: "late one", speaker: "Jo", posted_at: Date.UTC(2026, 10, 22, 6, 30), stars: 0 });
  const render = async (env) => (await handleWeb(new Request("https://bot.example/quotes/123456789", signedIn(db, ["123456789"])), env)).text();
  assert.match(await render({ DB: db, TIMEZONE: "America/Los_Angeles" }), /<span>Nov 21, 2026<\/span>/);
  assert.match(await render({ DB: db }), /<span>Nov 22, 2026<\/span>/);

  // 2am UTC Nov 22 is still Nov 21 in New York, so it picks the same quote as earlier that evening there.
  const lateNy = new Date(Date.UTC(2026, 10, 22, 2));
  const eveningNy = new Date(Date.UTC(2026, 10, 21, 23));
  const nextDayNy = new Date(Date.UTC(2026, 10, 22, 15));
  assert.equal(dailyIndex(1000, "America/New_York", lateNy), dailyIndex(1000, "America/New_York", eveningNy));
  assert.equal(dailyIndex(1000, "UTC", lateNy), dailyIndex(1000, "UTC", nextDayNy));
  assert.notEqual(dailyIndex(1000, "America/New_York", lateNy), dailyIndex(1000, "America/New_York", nextDayNy));
});
