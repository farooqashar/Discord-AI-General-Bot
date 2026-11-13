// /stats: who talks most, when, and about what. Plain counting, no AI, so it's free.

import { authorName, channelLabel, editOriginal, fetchHistory, getOption, NO_MENTIONS, targetChannel } from "../discord.js";

// Keeps each run well inside Cloudflare's limits (10 pages of 100).
const MAX_MESSAGES = 1000;

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

export function formatStats(stats, { where, days, guildId, channelId, capped }) {
  const lines = [`📊 **Stats for ${where}** · last ${days} day${days === 1 ? "" : "s"}`];
  lines.push(
    `**${stats.total.toLocaleString("en-US")}** messages from **${stats.peopleCount}** ${stats.peopleCount === 1 ? "person" : "people"}` +
      ` · ~${Math.round(stats.total / days)}/day · 🔗 ${stats.links} link${stats.links === 1 ? "" : "s"} · 📎 ${stats.files} file${stats.files === 1 ? "" : "s"}`,
  );
  if (capped) lines.push(`*(counted the most recent ${MAX_MESSAGES.toLocaleString("en-US")} messages)*`);

  const max = stats.people[0]?.[1] ?? 1;
  lines.push("", "**Most active**");
  for (const [name, n] of stats.people) lines.push(`\`${bar(n, max)}\` ${name} · ${n}`);

  lines.push("", `**Busiest:** ${stats.busiestDay}s around ${hourLabel(stats.busiestHour)}`);
  if (stats.words.length) lines.push(`**Top words:** ${stats.words.map(([w, n]) => `${w} (${n})`).join(", ")}`);
  if (stats.emoji.length) lines.push(`**Top emoji:** ${stats.emoji.map(([e, n]) => `${e} ${n}`).join("  ")}`);

  if (stats.mostReacted) {
    const { message, reactions } = stats.mostReacted;
    const snippet = (message.content || "(attachment)").replace(/\s+/g, " ").slice(0, 80);
    const link = guildId ? `https://discord.com/channels/${guildId}/${channelId}/${message.id}` : null;
    lines.push(
      `**Most reacted:** "${snippet}${message.content?.length > 80 ? "…" : ""}" (${authorName(message)}, ${reactions} reactions)${link ? ` ${link}` : ""}`,
    );
  }
  return lines.join("\n");
}

export async function stats(interaction, env) {
  const channelId = targetChannel(interaction, "get stats for");
  const days = getOption(interaction, "days") ?? 7;
  const since = new Date(Date.now() - days * 86400000);

  const history = await fetchHistory(env, channelId, MAX_MESSAGES, { since });
  const messages = history.filter((m) => !m.author?.bot);
  const where = channelLabel(interaction, channelId).replace(/^ in /, "") || "this channel";

  if (!messages.length) {
    await editOriginal(env, interaction, {
      content: `📊 No messages in ${where} in the last ${days} day${days === 1 ? "" : "s"}.`,
      allowed_mentions: NO_MENTIONS,
    });
    return;
  }

  const content = formatStats(computeStats(messages, env.TIMEZONE || "America/New_York"), {
    where,
    days,
    guildId: interaction.guild_id,
    channelId,
    capped: history.length >= MAX_MESSAGES,
  });
  await editOriginal(env, interaction, { content: content.slice(0, 1990), allowed_mentions: NO_MENTIONS });
}
