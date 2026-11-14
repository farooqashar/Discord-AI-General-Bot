// /wrapped: a short weekly or monthly recap of the server or one channel,
// posted on a schedule. It only ever covers channels every member can see,
// because the recap is posted publicly and no one is around to check who
// can read what.

import { extractStructured } from "../claude.js";
import {
  NO_MENTIONS,
  UserFacingError,
  authorName,
  canManageChannels,
  discordApi,
  editOriginal,
  fetchHistory,
  getOption,
  getSubcommand,
  sendChannelMessage,
} from "../discord.js";
import { WEEKDAYS, formatTime, initialLastSent, isDue, localNow, parseTime } from "../schedule.js";
import { computeStats, fetchServerMessages, isPublicChannel } from "./stats.js";

const DEFAULT_TIME = "6pm";
const CHANNEL_MAX_MESSAGES = 1000;
const CANDIDATES_FOR_AI = 120;

const SCHEMA = {
  type: "object",
  properties: {
    recap: {
      type: "string",
      description: "One playful sentence (under 25 words) on what the period was about",
    },
    funniest_index: {
      type: "integer",
      description: "Index of the funniest message, or -1 if none is genuinely funny",
    },
  },
  required: ["recap", "funniest_index"],
};

async function ensureTable(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS wrapped (
       channel_id TEXT PRIMARY KEY,
       guild_id TEXT NOT NULL,
       about_channel_id TEXT,
       frequency TEXT NOT NULL,
       weekday INTEGER,
       hour INTEGER NOT NULL,
       minute INTEGER NOT NULL,
       last_sent TEXT,
       created_by TEXT,
       created_at INTEGER NOT NULL DEFAULT (unixepoch())
     )`,
  ).run();
}

const plural = (n, word) => `${n.toLocaleString("en-US")} ${word}${n === 1 ? "" : "s"}`;
const short = (text, n) => {
  const t = (text || "(attachment)").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** Messages most worth showing the AI: the most reacted first, then the rest. */
function candidates(messages) {
  const reactions = (m) => (m.reactions ?? []).reduce((s, r) => s + (r.count ?? 0), 0);
  return [...messages]
    .filter((m) => m.content?.trim())
    .sort((a, b) => reactions(b) - reactions(a) || b.content.length - a.content.length)
    .slice(0, CANDIDATES_FOR_AI);
}

/** Check a channel is readable by everyone, so a public recap can't leak it. */
async function assertPublic(env, guildId, channelId) {
  const [guild, channel] = await Promise.all([
    discordApi(env, `/guilds/${guildId}`),
    discordApi(env, `/channels/${channelId}`),
  ]);
  if (!isPublicChannel(guild, channel)) {
    throw new UserFacingError("🔒 Wrapped only covers channels everyone in the server can see.");
  }
}

/** Build the recap text. */
export async function buildWrapped(env, { guildId, aboutChannelId, frequency }) {
  const timeZone = env.TIMEZONE || "America/New_York";
  const days = frequency === "monthly" ? 30 : 7;
  const since = new Date(Date.now() - days * 86400000);

  let messages;
  if (aboutChannelId) {
    await assertPublic(env, guildId, aboutChannelId);
    messages = (await fetchHistory(env, aboutChannelId, CHANNEL_MAX_MESSAGES, { since })).map((m) => ({
      ...m,
      channel_id: m.channel_id ?? aboutChannelId,
    }));
  } else {
    messages = (await fetchServerMessages(env, { guildId, member: null, since })).messages;
  }
  messages = messages.filter((m) => !m.author?.bot);

  const fmt = (d) => d.toLocaleDateString("en-US", { timeZone, month: "short", day: "numeric" });
  const title = `🎁 **${frequency === "monthly" ? "Monthly" : "Weekly"} Wrapped**${aboutChannelId ? ` · <#${aboutChannelId}>` : ""} · ${fmt(since)}–${fmt(new Date())}`;
  if (!messages.length) return `${title}\nA quiet ${frequency === "monthly" ? "month" : "week"}: no messages to wrap up.`;

  const stats = computeStats(messages, timeZone);
  const pool = candidates(messages);
  let pick = { recap: "", funniest_index: -1 };
  try {
    pick = await extractStructured(env, {
      system:
        "You write a playful, kind recap of a Discord group's chat. Never pick or mention anything mean, " +
        "embarrassing or private. Pick a genuinely funny message only if there is one.",
      prompt: `Messages (index: author: text):\n${pool.map((m, i) => `${i}: ${authorName(m)}: ${short(m.content, 200)}`).join("\n")}`,
      toolName: "wrapped",
      description: "Recap the period and pick the funniest message",
      schema: SCHEMA,
    });
  } catch (err) {
    // The numbers still make a fine recap without the AI part.
    console.warn("Wrapped recap AI step failed:", err.message);
  }

  const link = (m) => `https://discord.com/channels/${guildId}/${m.channel_id}/${m.id}`;
  const [mvp, mvpCount] = stats.people[0];
  const lines = [title];
  if (pick.recap) lines.push(`*${pick.recap.trim()}*`);
  lines.push(`💬 ${plural(stats.total, "message")} from ${plural(stats.peopleCount, "person").replace("persons", "people")} · 🏆 ${mvp} (${mvpCount})`);
  if (!aboutChannelId && stats.channels[0]) lines.push(`📍 Busiest channel: <#${stats.channels[0][0]}>`);
  if (stats.mostReacted) {
    const { message, reactions } = stats.mostReacted;
    lines.push(`⭐ "${short(message.content, 70)}" · ${authorName(message)}, ${plural(reactions, "reaction")} ${link(message)}`);
  }
  const funniest = pool[pick.funniest_index];
  if (funniest && funniest.id !== stats.mostReacted?.message.id) {
    lines.push(`😂 "${short(funniest.content, 70)}" · ${authorName(funniest)} ${link(funniest)}`);
  }
  if (stats.emoji.length) lines.push(`Top emoji: ${stats.emoji.slice(0, 3).map(([e]) => e).join(" ")}`);
  return lines.join("\n").slice(0, 1990);
}

function describeSchedule(w) {
  const when = w.frequency === "monthly" ? "on the 1st of each month" : `every ${WEEKDAYS[w.weekday][0].toUpperCase()}${WEEKDAYS[w.weekday].slice(1)}`;
  return `${w.about_channel_id ? `<#${w.about_channel_id}>` : "the whole server"} → <#${w.channel_id}>, ${when} at ${formatTime(w)}`;
}

export async function wrapped(interaction, env) {
  const action = getSubcommand(interaction) ?? "list";
  const timeZone = env.TIMEZONE || "America/New_York";
  if (!interaction.guild_id) throw new UserFacingError("Wrapped only works inside a server.");
  await ensureTable(env);
  const reply = (content) => editOriginal(env, interaction, { content, allowed_mentions: NO_MENTIONS });

  if ((action === "setup" || action === "off") && !canManageChannels(interaction)) {
    throw new UserFacingError("🔒 Only people who can manage channels can set up or stop Wrapped.");
  }

  if (action === "setup") {
    const channelId = getOption(interaction, "channel") ?? interaction.channel_id;
    const aboutChannelId = getOption(interaction, "about") ?? null;
    const frequency = getOption(interaction, "frequency") ?? "weekly";
    const weekday = WEEKDAYS.indexOf(getOption(interaction, "day") ?? "sunday");
    const time = parseTime(getOption(interaction, "time") ?? DEFAULT_TIME);
    if (aboutChannelId) await assertPublic(env, interaction.guild_id, aboutChannelId);

    const schedule = { frequency, weekday, ...time };
    const lastSent = initialLastSent(schedule, localNow(timeZone));
    await env.DB.prepare(
      `INSERT INTO wrapped (channel_id, guild_id, about_channel_id, frequency, weekday, hour, minute, last_sent, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(channel_id) DO UPDATE SET about_channel_id = excluded.about_channel_id, frequency = excluded.frequency,
         weekday = excluded.weekday, hour = excluded.hour, minute = excluded.minute, last_sent = excluded.last_sent`,
    )
      .bind(channelId, interaction.guild_id, aboutChannelId, frequency, weekday, time.hour, time.minute, lastSent, interaction.member?.user?.id ?? null)
      .run();
    await reply(
      `🎁 Wrapped is set: ${describeSchedule({ channel_id: channelId, about_channel_id: aboutChannelId, ...schedule })}.\n` +
        "It only covers channels everyone can see. Run `/wrapped now` to preview it.",
    );
    return;
  }

  if (action === "off") {
    const channelId = getOption(interaction, "channel") ?? interaction.channel_id;
    const { meta } = await env.DB.prepare("DELETE FROM wrapped WHERE channel_id = ?").bind(channelId).run();
    await reply(meta?.changes === 0 ? `There's no Wrapped set up for <#${channelId}>.` : `🛑 Stopped Wrapped in <#${channelId}>.`);
    return;
  }

  if (action === "now") {
    await reply(
      await buildWrapped(env, {
        guildId: interaction.guild_id,
        aboutChannelId: getOption(interaction, "about") ?? null,
        frequency: getOption(interaction, "frequency") ?? "weekly",
      }),
    );
    return;
  }

  // list
  const { results } = await env.DB.prepare("SELECT * FROM wrapped WHERE guild_id = ?").bind(interaction.guild_id).all();
  await reply(
    results.length
      ? `🎁 **Wrapped**\n${results.map(describeSchedule).join("\n")}`
      : "No Wrapped set up yet. Someone who can manage channels can run `/wrapped setup`.",
  );
}

/**
 * Post at most one due Wrapped per run (each one reads many channels, and a
 * run only gets 50 outside requests). Runs from the 5-minute cron.
 */
export async function postDueWrapped(env, { now = localNow(env.TIMEZONE || "America/New_York") } = {}) {
  if (!env.DB) return 0;
  await ensureTable(env);
  const { results } = await env.DB.prepare("SELECT * FROM wrapped").all();
  const next = results.find((w) => isDue(w, now));
  if (!next) return 0;

  await env.DB.prepare("UPDATE wrapped SET last_sent = ? WHERE channel_id = ?").bind(now.date, next.channel_id).run();
  try {
    const content = await buildWrapped(env, {
      guildId: next.guild_id,
      aboutChannelId: next.about_channel_id,
      frequency: next.frequency,
    });
    await sendChannelMessage(env, next.channel_id, { content, allowed_mentions: NO_MENTIONS });
  } catch (err) {
    console.error(`Wrapped for ${next.channel_id} failed:`, err);
    if (err.status === 404) await env.DB.prepare("DELETE FROM wrapped WHERE channel_id = ?").bind(next.channel_id).run();
  }
  return 1;
}
