// "Sign in with Discord" (OAuth2) for the bot's web pages.
//
// The visitor approves on discord.com; Discord sends them back with a
// one-time code, which we swap for their identity and server list. We keep
// only their user ID, name and the IDs of servers they're in, in a session
// row keyed by a random cookie, for SESSION_DAYS. We never see their password,
// and we don't keep Discord's access token. That server list is only a
// snapshot, so stillMember() asks Discord again (with the bot token) every
// RECHECK_MINUTES before showing a server's Quote Book.

import { discordApi } from "../discord.js";

const API = "https://discord.com/api/v10";
export const SESSION_COOKIE = "qb_session";
const STATE_COOKIE = "qb_state";
const SESSION_DAYS = 7;
const RECHECK_MINUTES = 15;

export async function ensureSessionTable(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS web_sessions (
       token TEXT PRIMARY KEY,
       user_id TEXT NOT NULL,
       username TEXT,
       guild_ids TEXT NOT NULL,
       expires_at INTEGER NOT NULL
     )`,
  ).run();
  // When each session was last confirmed, by Discord, to still be in each server.
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS web_session_checks (
       token TEXT NOT NULL,
       guild_id TEXT NOT NULL,
       verified_at INTEGER NOT NULL,
       PRIMARY KEY (token, guild_id)
     )`,
  ).run();
}

const randomToken = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
};

export function parseCookies(request) {
  const out = {};
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const cookie = (name, value, maxAge) =>
  `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

/** Only allow returning to our own Quote Book pages after sign-in. */
export function safeNext(next) {
  return typeof next === "string" && /^\/quotes(\/\d{5,25})?\/?(\?[^#]*)?$/.test(next) ? next : "/quotes";
}

const callbackUrl = (request) => `${new URL(request.url).origin}/auth/callback`;

/** /auth/login: send the visitor to Discord to approve. */
export function startLogin(request, env) {
  if (!env.DISCORD_CLIENT_SECRET || !env.DISCORD_APP_ID) {
    return new Response("Sign-in isn't set up yet: the DISCORD_CLIENT_SECRET secret is missing.", { status: 503 });
  }
  const next = safeNext(new URL(request.url).searchParams.get("next"));
  const state = `${randomToken()}.${encodeURIComponent(next)}`;
  const url = new URL("https://discord.com/oauth2/authorize");
  url.search = new URLSearchParams({
    client_id: env.DISCORD_APP_ID,
    response_type: "code",
    scope: "identify guilds",
    redirect_uri: callbackUrl(request),
    state,
    prompt: "none",
  });
  return new Response(null, {
    status: 302,
    headers: { Location: url.toString(), "Set-Cookie": cookie(STATE_COOKIE, state, 600) },
  });
}

/** /auth/callback: check the state, swap the code for who they are, start a session. */
export async function finishLogin(request, env) {
  const params = new URL(request.url).searchParams;
  const state = params.get("state");
  const code = params.get("code");
  if (params.get("error")) return redirect("/quotes?signin=cancelled");
  // The state must match the cookie we set, so another site can't log someone in as an attacker.
  if (!code || !state || parseCookies(request)[STATE_COOKIE] !== state) {
    return new Response("That sign-in link expired. Go back and sign in again.", { status: 400 });
  }

  const tokenRes = await fetch(`${API}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.DISCORD_APP_ID,
      client_secret: env.DISCORD_CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
      redirect_uri: callbackUrl(request),
    }),
  });
  if (!tokenRes.ok) {
    console.error("Discord token exchange failed:", tokenRes.status, (await tokenRes.text()).slice(0, 200));
    return new Response("Discord didn't accept that sign-in. Go back and try again.", { status: 502 });
  }
  const { access_token: accessToken } = await tokenRes.json();
  const auth = { Authorization: `Bearer ${accessToken}` };
  const [userRes, guildsRes] = await Promise.all([
    fetch(`${API}/users/@me`, { headers: auth }),
    fetch(`${API}/users/@me/guilds`, { headers: auth }),
  ]);
  if (!userRes.ok || !guildsRes.ok) return new Response("Couldn't read your Discord account. Try again.", { status: 502 });
  const user = await userRes.json();
  const guilds = await guildsRes.json();

  await ensureSessionTable(env);
  const token = randomToken();
  const expires = Date.now() + SESSION_DAYS * 86400000;
  await env.DB.prepare("INSERT INTO web_sessions (token, user_id, username, guild_ids, expires_at) VALUES (?, ?, ?, ?, ?)")
    .bind(token, user.id, user.global_name ?? user.username, JSON.stringify(guilds.map((g) => g.id)), expires)
    .run();
  // Tidy up expired sessions now and then.
  await env.DB.prepare("DELETE FROM web_sessions WHERE expires_at < ?").bind(Date.now()).run();
  await env.DB.prepare("DELETE FROM web_session_checks WHERE token NOT IN (SELECT token FROM web_sessions)").run();

  const next = safeNext(decodeURIComponent(state.split(".").slice(1).join(".")));
  const headers = new Headers({ Location: next });
  headers.append("Set-Cookie", cookie(SESSION_COOKIE, token, SESSION_DAYS * 86400));
  headers.append("Set-Cookie", cookie(STATE_COOKIE, "", 0));
  return new Response(null, { status: 302, headers });
}

/** The signed-in visitor, or null. */
export async function currentSession(request, env) {
  const token = parseCookies(request)[SESSION_COOKIE];
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  await ensureSessionTable(env);
  const row = await env.DB.prepare("SELECT * FROM web_sessions WHERE token = ?").bind(token).first();
  if (!row || row.expires_at < Date.now()) return null;
  return { ...row, guildIds: JSON.parse(row.guild_ids) };
}

/**
 * Is the signed-in visitor still in this server? Trusts a check younger than
 * RECHECK_MINUTES, otherwise asks Discord. Returns true or false, or null when
 * Discord couldn't be reached (callers should deny, not fall back).
 * Someone who has left, or was kicked or banned, loses the server from their session.
 */
export async function stillMember(env, session, guildId) {
  if (!session.guildIds.includes(guildId)) return false;
  const check = await env.DB.prepare("SELECT verified_at FROM web_session_checks WHERE token = ? AND guild_id = ?")
    .bind(session.token, guildId)
    .first();
  if (check && Date.now() - check.verified_at < RECHECK_MINUTES * 60000) return true;

  try {
    await discordApi(env, `/guilds/${guildId}/members/${session.user_id}`);
  } catch (err) {
    if (err.status !== 404) {
      console.error("Quote Book membership re-check failed:", err.message);
      return null;
    }
    session.guildIds = session.guildIds.filter((id) => id !== guildId);
    await env.DB.prepare("UPDATE web_sessions SET guild_ids = ? WHERE token = ?").bind(JSON.stringify(session.guildIds), session.token).run();
    await env.DB.prepare("DELETE FROM web_session_checks WHERE token = ? AND guild_id = ?").bind(session.token, guildId).run();
    return false;
  }
  await env.DB.prepare("INSERT OR REPLACE INTO web_session_checks (token, guild_id, verified_at) VALUES (?, ?, ?)")
    .bind(session.token, guildId, Date.now())
    .run();
  return true;
}

/** /auth/logout */
export async function logout(request, env) {
  const token = parseCookies(request)[SESSION_COOKIE];
  if (token) {
    await ensureSessionTable(env);
    await env.DB.prepare("DELETE FROM web_sessions WHERE token = ?").bind(token).run();
    await env.DB.prepare("DELETE FROM web_session_checks WHERE token = ?").bind(token).run();
  }
  return new Response(null, { status: 302, headers: { Location: "/quotes", "Set-Cookie": cookie(SESSION_COOKIE, "", 0) } });
}

const redirect = (to) => new Response(null, { status: 302, headers: { Location: to } });
