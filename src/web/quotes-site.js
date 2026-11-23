// The Quote Book website. Server-rendered HTML, no JavaScript, members only.

import { ensureQuoteTables } from "../commands/quotes.js";
import { currentSession, finishLogin, logout, startLogin } from "./auth.js";

const PAGE_SIZE = 120;

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const SECURITY_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
  "Cache-Control": "private, no-store",
};

const html = (body, status = 200) => new Response(body, { status, headers: SECURITY_HEADERS });

const STYLES = `
:root {
  --paper: #eef1f6; --ink: #1c2140; --muted: #596083; --line: #d6dbe7;
  --pink: #ff4fa3; --blue: #2f6bff; --field: #ffffff;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root { --paper: #121528; --ink: #eceef8; --muted: #9aa1c2; --line: #2b3050; --field: #1a1e36; color-scheme: dark; }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0; background: var(--paper); color: var(--ink);
  font-family: "Bricolage Grotesque", system-ui, sans-serif; font-size: 17px; line-height: 1.5;
}
a { color: inherit; text-decoration-thickness: 1px; text-underline-offset: 3px; }
a:hover { color: var(--blue); }
:focus-visible { outline: 3px solid var(--blue); outline-offset: 3px; border-radius: 2px; }
.wrap { max-width: 1180px; margin: 0 auto; padding: 0 24px; }
header.top { display: flex; justify-content: space-between; align-items: baseline; gap: 16px; padding: 28px 0 0; }
.brand { font-weight: 800; font-size: 1.05rem; letter-spacing: -0.01em; text-decoration: none; }
.brand span { color: var(--muted); font-weight: 500; }
.who { color: var(--muted); font-size: 0.95rem; }

/* The one loud thing: today's quote, printed like a slightly misregistered riso. */
.today { padding: 72px 0 64px; border-bottom: 1px solid var(--line); }
.today p.label { margin: 0 0 18px; color: var(--muted); font-size: 0.95rem; }
.today blockquote { margin: 0; }
.today blockquote p {
  margin: 0; max-width: 15ch; font-weight: 800; font-size: clamp(2.4rem, 7vw, 5.6rem); line-height: 0.98; letter-spacing: -0.035em;
  text-shadow: 0.045em 0.035em 0 var(--pink), -0.03em -0.02em 0 var(--blue);
}
.today footer { margin-top: 26px; font-size: 1.15rem; font-weight: 600; }
.today footer a { color: var(--muted); font-weight: 400; margin-left: 12px; }

form.find { display: flex; gap: 10px; margin: 36px 0 16px; }
form.find input[type=search] {
  flex: 1 1 auto; min-width: 0; font: inherit; color: var(--ink); background: var(--field);
  border: 1.5px solid var(--line); border-radius: 999px; padding: 10px 18px;
}
form.find button {
  font: inherit; font-weight: 700; color: var(--paper); background: var(--ink);
  border: 0; border-radius: 999px; padding: 10px 22px; cursor: pointer;
}
nav.filters { display: flex; flex-wrap: wrap; gap: 8px 18px; align-items: baseline; margin-bottom: 8px; color: var(--muted); }
nav.filters a { text-decoration: none; color: var(--muted); }
nav.filters a[aria-current=true] { color: var(--ink); font-weight: 700; text-decoration: underline; text-decoration-color: var(--pink); text-decoration-thickness: 3px; }
nav.filters .group { display: flex; flex-wrap: wrap; gap: 6px 16px; }
nav.filters .gap { flex-basis: 100%; height: 0; }

.count { color: var(--muted); font-size: 0.95rem; margin: 20px 0 8px; }
.wall { columns: 20rem; column-gap: 56px; padding-bottom: 80px; }
.wall article { break-inside: avoid; padding: 26px 0 22px; border-top: 1px solid var(--line); }
.wall blockquote { margin: 0; }
.wall blockquote p { margin: 0; font-size: 1.32rem; line-height: 1.32; font-weight: 600; letter-spacing: -0.01em; }
.wall footer { margin-top: 10px; color: var(--muted); font-size: 0.95rem; display: flex; flex-wrap: wrap; gap: 4px 14px; }
.wall footer strong { color: var(--ink); font-weight: 600; }
.wall .stars { color: var(--muted); }
.wall .hof .stars { color: var(--pink); font-weight: 700; }

.empty { padding: 60px 0 100px; font-size: 1.15rem; }
.gate { min-height: 100vh; display: grid; place-content: center; padding: 40px 24px; }
.gate h1 {
  margin: 0; font-weight: 800; font-size: clamp(2.8rem, 9vw, 6rem); line-height: 0.95; letter-spacing: -0.04em;
  text-shadow: 0.045em 0.035em 0 var(--pink), -0.03em -0.02em 0 var(--blue);
}
.gate p { max-width: 34ch; font-size: 1.15rem; color: var(--muted); margin: 22px 0 30px; }
.gate a.button {
  display: inline-block; text-decoration: none; font-weight: 700; color: #fff; background: #5865f2;
  border-radius: 999px; padding: 14px 26px;
}
.gate a.button:hover { color: #fff; background: #4752c4; }
footer.site { color: var(--muted); font-size: 0.9rem; padding: 0 0 40px; }
@media (max-width: 600px) {
  .wrap { padding: 0 16px; }
  .today { padding: 48px 0 44px; }
  .wall { column-gap: 0; }
}
`;

function page(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,400..800&display=swap" rel="stylesheet">
<style>${STYLES}</style>
</head>
<body>${body}</body>
</html>`;
}

function gatePage({ heading, message, next, signedIn }) {
  const action = signedIn
    ? `<a class="button" href="/auth/logout">Sign out</a>`
    : `<a class="button" href="/auth/login?next=${encodeURIComponent(next)}">Sign in with Discord</a>`;
  return html(
    page(
      "Quote Book",
      `<main class="gate"><h1>${escapeHtml(heading)}</h1><p>${escapeHtml(message)}</p><div>${action}</div></main>`,
    ),
    signedIn ? 403 : 200,
  );
}

const formatDate = (ms, timeZone) =>
  new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone });

const speakerOf = (q) => q.speaker || "Unknown";
const messageLink = (q) => `https://discord.com/channels/${q.guild_id}/${q.channel_id}/${q.message_id}`;

/** Same quote all day, a different one tomorrow. */
export function dailyIndex(count, timeZone, date = new Date()) {
  const key = date.toLocaleDateString("en-CA", { timeZone });
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % count;
}

function quoteCard(q, timeZone) {
  const stars = q.stars ? `<span class="stars" title="${q.stars >= 3 ? "Hall of fame" : "Stars"}">⭐ ${q.stars}</span>` : "";
  return `<article class="${q.stars >= 3 ? "hof" : ""}">
<blockquote><p>“${escapeHtml(q.text)}”</p></blockquote>
<footer><strong>${escapeHtml(speakerOf(q))}</strong><span>${formatDate(q.posted_at, timeZone)}</span>${stars}<a href="${messageLink(q)}">Open in Discord</a></footer>
</article>`;
}

function link(params, changes) {
  const p = new URLSearchParams(params);
  for (const [k, v] of Object.entries(changes)) {
    if (v == null || v === "") p.delete(k);
    else p.set(k, v);
  }
  const s = p.toString();
  return s ? `?${s}` : "?";
}

export async function renderQuoteBook(env, book, session, searchParams) {
  const timeZone = env.TIMEZONE || "America/New_York";
  const q = (searchParams.get("q") ?? "").trim().slice(0, 100);
  const by = (searchParams.get("by") ?? "").trim().slice(0, 60);
  const sort = ["new", "top", "shuffle"].includes(searchParams.get("sort")) ? searchParams.get("sort") : "new";
  const params = { q, by, sort: sort === "new" ? "" : sort };

  const { results: totals } = await env.DB.prepare("SELECT COUNT(*) AS n FROM quotes WHERE guild_id = ?").bind(book.guild_id).all();
  const total = totals[0]?.n ?? 0;

  let today = null;
  if (total) {
    today = await env.DB.prepare("SELECT * FROM quotes WHERE guild_id = ? ORDER BY message_id LIMIT 1 OFFSET ?")
      .bind(book.guild_id, dailyIndex(total, timeZone))
      .first();
  }

  const { results: speakers } = await env.DB.prepare(
    `SELECT COALESCE(speaker, 'Unknown') AS name, COUNT(*) AS n FROM quotes WHERE guild_id = ?
     GROUP BY COALESCE(speaker, 'Unknown') ORDER BY n DESC LIMIT 12`,
  )
    .bind(book.guild_id)
    .all();

  const where = ["guild_id = ?"];
  const args = [book.guild_id];
  if (q) {
    where.push("(text LIKE ? OR speaker LIKE ?)");
    args.push(`%${q}%`, `%${q}%`);
  }
  if (by) {
    if (by === "Unknown") where.push("speaker IS NULL");
    else {
      where.push("speaker = ?");
      args.push(by);
    }
  }
  const order = sort === "top" ? "stars DESC, reactions DESC, posted_at DESC" : sort === "shuffle" ? "RANDOM()" : "posted_at DESC";
  const { results: shown } = await env.DB.prepare(
    `SELECT * FROM quotes WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ${PAGE_SIZE}`,
  )
    .bind(...args)
    .all();

  const serverName = book.guild_name || "your server";
  const sortLink = (value, label) =>
    `<a href="${escapeHtml(link(params, { sort: value === "new" ? "" : value }))}" aria-current="${sort === value}">${label}</a>`;
  const byLink = (name, label) =>
    `<a href="${escapeHtml(link(params, { by: name }))}" aria-current="${by === (name ?? "")}">${escapeHtml(label)}</a>`;

  const hero = today
    ? `<section class="today"><p class="label">Quote of the day</p>
<blockquote><p>“${escapeHtml(today.text)}”</p></blockquote>
<footer>${escapeHtml(speakerOf(today))}<a href="${messageLink(today)}">Open in Discord</a></footer></section>`
    : "";

  const filtered = q || by;
  const body = shown.length
    ? `<p class="count">${filtered ? `${shown.length} ${shown.length === 1 ? "quote matches" : "quotes match"}` : `${total} ${total === 1 ? "quote" : "quotes"} saved`}${shown.length === PAGE_SIZE ? `, showing the first ${PAGE_SIZE}` : ""}</p>
<section class="wall">${shown.map((quote) => quoteCard(quote, timeZone)).join("\n")}</section>`
    : total
      ? `<p class="empty">No quotes match${q ? ` “${escapeHtml(q)}”` : ""}${by ? ` from ${escapeHtml(by)}` : ""}. <a href="?">Show every quote</a></p>`
      : `<p class="empty">No quotes saved yet. Post one in the quotes channel, like <strong>"I'm not lost, the LIRR is" - Ashar</strong>, and it shows up here within a few minutes.</p>`;

  return html(
    page(
      `Quote Book: ${serverName}`,
      `<div class="wrap">
<header class="top"><a class="brand" href="?">Quote Book <span>${escapeHtml(serverName)}</span></a>
<span class="who">${escapeHtml(session.username ?? "")} <a href="/auth/logout">Sign out</a></span></header>
${hero}
<form class="find" method="get" role="search">
<input type="search" name="q" value="${escapeHtml(q)}" placeholder="Search quotes or people" aria-label="Search quotes or people">
${by ? `<input type="hidden" name="by" value="${escapeHtml(by)}">` : ""}${params.sort ? `<input type="hidden" name="sort" value="${escapeHtml(params.sort)}">` : ""}
<button type="submit">Search</button>
</form>
<nav class="filters" aria-label="Filter and sort">
<div class="group">${sortLink("new", "Newest")}${sortLink("top", "Most starred")}${sortLink("shuffle", "Shuffle")}</div>
<span class="gap"></span>
<div class="group">${byLink(null, "Everyone")}${speakers.map((s) => byLink(s.name, `${s.name} (${s.n})`)).join("")}</div>
</nav>
${body}
<footer class="site">New quotes from the quotes channel appear within a few minutes. ⭐ a quote in Discord to help it into the hall of fame.</footer>
</div>`,
    ),
  );
}

/** Handle GET requests for the website. Returns null for paths it doesn't own. */
export async function handleWeb(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (path === "/auth/login") return startLogin(request, env);
  if (path === "/auth/callback") return finishLogin(request, env);
  if (path === "/auth/logout") return logout(request, env);
  if (path !== "/quotes" && !path.startsWith("/quotes/")) return null;

  await ensureQuoteTables(env);
  const session = await currentSession(request, env);
  const guildId = path.split("/")[2];

  if (!session) {
    return gatePage({
      heading: "Things we said.",
      message: "This Quote Book is only for members of the server. Sign in with Discord to read it.",
      next: url.pathname + url.search,
    });
  }

  if (!guildId) {
    // Send them to the Quote Book of a server they're in.
    const { results } = await env.DB.prepare("SELECT guild_id FROM quote_books").all();
    const mine = results.filter((b) => session.guildIds.includes(b.guild_id));
    if (mine.length) return new Response(null, { status: 302, headers: { Location: `/quotes/${mine[0].guild_id}` } });
    return gatePage({ heading: "Nothing here for you.", message: "None of your servers have a Quote Book yet.", signedIn: true });
  }

  if (!/^\d{5,25}$/.test(guildId)) return gatePage({ heading: "Not found.", message: "That Quote Book doesn't exist.", signedIn: true });
  const book = await env.DB.prepare("SELECT * FROM quote_books WHERE guild_id = ?").bind(guildId).first();
  const hasAny = await env.DB.prepare("SELECT 1 FROM quotes WHERE guild_id = ? LIMIT 1").bind(guildId).first();
  if (!book && !hasAny) return gatePage({ heading: "Not found.", message: "That server doesn't have a Quote Book.", signedIn: true });
  if (!session.guildIds.includes(guildId)) {
    return gatePage({
      heading: "Members only.",
      message: `This Quote Book is for members of ${book?.guild_name || "that server"}. If you just joined, sign out and back in.`,
      signedIn: true,
    });
  }
  return renderQuoteBook(env, book ?? { guild_id: guildId }, session, url.searchParams);
}
