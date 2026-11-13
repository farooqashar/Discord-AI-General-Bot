// /stats: who talks most, when, and about what, for the whole server or one
// channel. Plain counting, no AI, so it's free.

import {
  NO_MENTIONS,
  authorName,
  channelLabel,
  discordApi,
  editOriginal,
  fetchHistory,
  getOption,
  targetChannel,
} from "../discord.js";

// Keeps each run well inside Cloudflare's limits (10 pages of 100).
const MAX_MESSAGES = 1000;

// Whole-server stats read many channels. Cloudflare's free plan allows 50
// outside requests per run, and Discord's "slow down" retries count too, so
// reading stops after this many pages, leaving plenty of room for retries,
// the channel list and the reply. It also stops after a time limit, since
// background work only gets about 30 seconds.
const SERVER_PAGE_BUDGET = 30;
const SERVER_MAX_MESSAGES = 3000;
const SERVER_TIME_BUDGET_MS = 18000;

const ADMINISTRATOR = 1n << 3n;
const VIEW_CHANNEL = 1n << 10n;
const READ_MESSAGE_HISTORY = 1n << 16n;
const DISCORD_EPOCH = 1420070400000n;

const STOPWORDS = new Set(
  `the and for that this with you are was but not have just what all its it's i'm dont don't can
  get got like they them then there their from your about out one would will been were had has
  how why who when where which also too very really yeah yes lol lmao its im u ur ok okay oh
  some any more most much than our his her she him into over only even still now did does doing
  should could gonna wanna going thats that's those these here want need know think make sure
  let lets let's say said well back way being because can't cant didn't didnt isn't isnt it'll
  i'll i've you're youre we're were he's she's what's whats ill ive gotta again`.split(/\s+/),
);

const CUSTOM_EMOJI = /<a?:\w+:\d+>/g;
const UNICODE_EMOJI = /\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic})*/gu;

const top = (counts, n) => [...counts].sort((a, b) => b[1] - a[1]).slice(0, n);
const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);
const bar = (n, max) => "▰".repeat(Math.max(1, Math.round((n / max) * 8))).padEnd(8, "▱");

/** Exact counts for a set of messages (oldest or newest first, doesn't matter). */
export function computeStats(messages, timeZone) {
  const people = new Map();
  const channels = new Map();
  const words = new Map();
  const emoji = new Map();
  const days = new Map();
  const hours = new Array(24).fill(0);
  let links = 0;
  let files = 0;
  let mostReacted = null;

  const dayFmt = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long" });
  const hourFmt = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23" });

  for (const m of messages) {
    const when = new Date(m.timestamp);
    bump(people, authorName(m));
    if (m.channel_id) bump(channels, m.channel_id);
    bump(days, dayFmt.format(when));
    hours[Number(hourFmt.format(when)) % 24]++;
    files += m.attachments?.length ?? 0;

    const text = m.content ?? "";
    links += (text.match(/https?:\/\//g) ?? []).length;
    for (const e of text.match(CUSTOM_EMOJI) ?? []) bump(emoji, e);
    for (const e of text.replace(CUSTOM_EMOJI, "").match(UNICODE_EMOJI) ?? []) bump(emoji, e);
    for (const r of m.reactions ?? []) {
      const key = r.emoji?.id ? `<${r.emoji.animated ? "a" : ""}:${r.emoji.name}:${r.emoji.id}>` : r.emoji?.name;
      if (key) emoji.set(key, (emoji.get(key) ?? 0) + (r.count ?? 1));
    }

    const cleaned = text
      .toLowerCase()
      .replace(/https?:\/\/\S+/g, " ")
      .replace(/<[@#!&a]?:?[\w:]*\d+>/g, " ")
      .replace(/[^\p{L}\p{N}'\s]/gu, " ");
    for (const w of cleaned.split(/\s+/)) {
      const word = w.replace(/^'+|'+$/g, "");
      if (word.length >= 3 && !STOPWORDS.has(word) && !/^\d+$/.test(word)) bump(words, word);
    }

    const reactions = (m.reactions ?? []).reduce((sum, r) => sum + (r.count ?? 0), 0);
    if (reactions > 0 && (!mostReacted || reactions > mostReacted.reactions)) {
      mostReacted = { message: m, reactions };
    }
  }

  return {
    total: messages.length,
    people: top(people, 5),
    channels: top(channels, 5),
    channelCount: channels.size,
    peopleCount: people.size,
    busiestDay: top(days, 1)[0]?.[0],
    busiestHour: hours.indexOf(Math.max(...hours)),
    words: top(words, 5),
    emoji: top(emoji, 5),
    links,
    files,
    mostReacted,
  };
}

const hourLabel = (h) => `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? "AM" : "PM"}`;

export function formatStats(stats, { where, days, guildId, channelId, capped, server = false, note }) {
  const lines = [`📊 **Stats for ${where}** · last ${days} day${days === 1 ? "" : "s"}`];
  lines.push(
    `**${stats.total.toLocaleString("en-US")}** messages from **${stats.peopleCount}** ${stats.peopleCount === 1 ? "person" : "people"}` +
      ` · ~${Math.round(stats.total / days)}/day · 🔗 ${stats.links} link${stats.links === 1 ? "" : "s"} · 📎 ${stats.files} file${stats.files === 1 ? "" : "s"}`,
  );
  if (capped) lines.push(`*(counted the most recent ${MAX_MESSAGES.toLocaleString("en-US")} messages)*`);
  if (note) lines.push(`*(${note})*`);

  const max = stats.people[0]?.[1] ?? 1;
  lines.push("", "**Most active**");
  for (const [name, n] of stats.people) lines.push(`\`${bar(n, max)}\` ${name} · ${n}`);

  if (server && stats.channels.length > 1) {
    const maxC = stats.channels[0][1];
    lines.push("", "**Most active channels**");
    for (const [id, n] of stats.channels) lines.push(`\`${bar(n, maxC)}\` <#${id}> · ${n}`);
  }

  lines.push("", `**Busiest:** ${stats.busiestDay}s around ${hourLabel(stats.busiestHour)}`);
  if (stats.words.length) lines.push(`**Top words:** ${stats.words.map(([w, n]) => `${w} (${n})`).join(", ")}`);
  if (stats.emoji.length) lines.push(`**Top emoji:** ${stats.emoji.map(([e, n]) => `${e} ${n}`).join("  ")}`);

  if (stats.mostReacted) {
    const { message, reactions } = stats.mostReacted;
    const snippet = (message.content || "(attachment)").replace(/\s+/g, " ").slice(0, 80);
    const link = guildId ? `https://discord.com/channels/${guildId}/${message.channel_id ?? channelId}/${message.id}` : null;
    lines.push(
      `**Most reacted:** "${snippet}${message.content?.length > 80 ? "…" : ""}" (${authorName(message)}, ${reactions} reactions)${link ? ` ${link}` : ""}`,
    );
  }
  return lines.join("\n");
}

/** When a message or channel's latest message was sent, from its snowflake ID. */
export const snowflakeTime = (id) => Number((BigInt(id) >> 22n) + DISCORD_EPOCH);

/**
 * The asker's server-wide permissions, from @everyone plus their roles.
 * (The permissions Discord attaches to a command already include the
 * overrides of the channel it was run in, so they can't be used here.)
 */
export function basePermissions(guild, member) {
  const ALL = (1n << 53n) - 1n;
  if (member?.user?.id && member.user.id === guild.owner_id) return ALL;
  const roles = new Map((guild.roles ?? []).map((r) => [r.id, BigInt(r.permissions ?? 0)]));
  let perms = roles.get(guild.id) ?? 0n; // the @everyone role shares the server's ID
  for (const id of member?.roles ?? []) perms |= roles.get(id) ?? 0n;
  return perms & ADMINISTRATOR ? ALL : perms;
}

/**
 * The asker's permissions in one channel: their server-wide permissions,
 * then the channel's overrides for @everyone, their roles, and them.
 */
export function channelPermissions(member, guildId, channel, base = BigInt(member?.permissions ?? 0)) {
  let perms = base;
  if (perms & ADMINISTRATOR) return perms | VIEW_CHANNEL | READ_MESSAGE_HISTORY;
  const overwrites = channel.permission_overwrites ?? [];
  const apply = (o) => {
    perms &= ~BigInt(o.deny ?? 0);
    perms |= BigInt(o.allow ?? 0);
  };
  const everyone = overwrites.find((o) => o.id === guildId);
  if (everyone) apply(everyone);
  let allow = 0n;
  let deny = 0n;
  for (const o of overwrites) {
    if (o.type === 0 && o.id !== guildId && member?.roles?.includes(o.id)) {
      allow |= BigInt(o.allow ?? 0);
      deny |= BigInt(o.deny ?? 0);
    }
  }
  perms &= ~deny;
  perms |= allow;
  const own = overwrites.find((o) => o.type === 1 && o.id === member?.user?.id);
  if (own) apply(own);
  return perms;
}

const canRead = (perms) => (perms & VIEW_CHANNEL) !== 0n && (perms & READ_MESSAGE_HISTORY) !== 0n;

/** Messages from every channel the asker can read, busiest-recently first, within the budget. */
async function fetchServer(env, interaction, since) {
  const [guild, channels] = await Promise.all([
    discordApi(env, `/guilds/${interaction.guild_id}`),
    discordApi(env, `/guilds/${interaction.guild_id}/channels`),
  ]);
  const base = basePermissions(guild, interaction.member);
  const candidates = channels
    .filter((c) => c.type === 0 || c.type === 5) // text and announcement channels
    .filter((c) => c.last_message_id && snowflakeTime(c.last_message_id) >= since.getTime())
    .filter((c) => canRead(channelPermissions(interaction.member, interaction.guild_id, c, base)))
    .sort((a, b) => (BigInt(b.last_message_id) > BigInt(a.last_message_id) ? 1 : -1));

  const messages = [];
  const started = Date.now();
  let pages = 0;
  let read = 0;
  let unreadable = 0;
  let failed = 0;
  let stoppedEarly = false;
  const outOfBudget = () =>
    pages >= SERVER_PAGE_BUDGET || messages.length >= SERVER_MAX_MESSAGES || Date.now() - started > SERVER_TIME_BUDGET_MS;
  for (const channel of candidates) {
    if (outOfBudget()) {
      stoppedEarly = true;
      break;
    }
    let before;
    try {
      while (!outOfBudget()) {
        pages++;
        const page = await discordApi(
          env,
          `/channels/${channel.id}/messages?limit=100${before ? `&before=${before}` : ""}`,
        );
        const recent = page.filter((m) => new Date(m.timestamp) >= since);
        messages.push(...recent.map((m) => ({ ...m, channel_id: m.channel_id ?? channel.id })));
        if (recent.length < page.length || page.length < 100) break;
        before = page[page.length - 1].id;
      }
      read++;
    } catch (err) {
      // One channel failing shouldn't sink the whole command: skip it and
      // keep whatever was already counted.
      if (err.status === 403) {
        unreadable++;
      } else if (/too many subrequests/i.test(err.message)) {
        console.warn("Hit the request limit while reading channels; using what was read so far");
        stoppedEarly = true;
        break;
      } else {
        console.warn(`Skipped channel ${channel.id} for /stats:`, err.message);
        failed++;
      }
    }
  }
  if (read < candidates.length - unreadable - failed) stoppedEarly = true;
  return { messages, read, unreadable, failed, stoppedEarly };
}

export async function stats(interaction, env) {
  const days = getOption(interaction, "days") ?? 7;
  const since = new Date(Date.now() - days * 86400000);
  const timeZone = env.TIMEZONE || "America/New_York";
  const plural = days === 1 ? "" : "s";

  // No channel picked (and we're in a server): stats for the whole server.
  const server = !getOption(interaction, "channel") && Boolean(interaction.guild_id);

  let messages;
  let where;
  let capped = false;
  let note;
  let channelId = interaction.channel_id;
  if (server) {
    const result = await fetchServer(env, interaction, since);
    messages = result.messages.filter((m) => !m.author?.bot);
    where = "the server";
    const parts = [`${result.read} channel${result.read === 1 ? "" : "s"} you can read`];
    if (result.failed) parts.push(`${result.failed} couldn't be read right now`);
    if (result.stoppedEarly) parts.push("stopped early on the busiest channels; try fewer days for a full count");
    note = parts.join(" · ");
  } else {
    channelId = targetChannel(interaction, "get stats for");
    const history = await fetchHistory(env, channelId, MAX_MESSAGES, { since });
    messages = history.filter((m) => !m.author?.bot);
    where = channelLabel(interaction, channelId).replace(/^ in /, "") || "this channel";
    capped = history.length >= MAX_MESSAGES;
  }

  if (!messages.length) {
    await editOriginal(env, interaction, {
      content: `📊 No messages in ${where} in the last ${days} day${plural}.`,
      allowed_mentions: NO_MENTIONS,
    });
    return;
  }

  const content = formatStats(computeStats(messages, timeZone), {
    where,
    days,
    guildId: interaction.guild_id,
    channelId,
    capped,
    server,
    note,
  });
  await editOriginal(env, interaction, { content: content.slice(0, 1990), allowed_mentions: NO_MENTIONS });
}
