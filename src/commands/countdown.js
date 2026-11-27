// /countdown: count down to a date. Shows days left (or hours, minutes and
// seconds on the last day), and posts an alert in the channel when it hits zero.

import { describeNow, extractStructured } from "../claude.js";
import {
  NO_MENTIONS,
  UserFacingError,
  canManageChannels,
  discordApi,
  discordTimestamp,
  editOriginal,
  getOption,
  getSubcommand,
  invokingUser,
  sendChannelMessage,
} from "../discord.js";
import { isPublicChannel } from "./stats.js";

const MAX_PER_SERVER = 25;
const MAX_AHEAD = 5 * 366 * 24 * 60 * 60 * 1000; // about 5 years
const DAY = 24 * 60 * 60 * 1000;
// An alert that keeps failing for a passing reason is retried each minute
// until it is this late, then dropped.
const GIVE_UP_AFTER = 60 * 60;
const THREAD_TYPES = new Set([10, 11, 12]);
const PRIVATE_THREAD = 12;

export async function ensureCountdownTable(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS countdowns (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       guild_id TEXT NOT NULL,
       channel_id TEXT NOT NULL,
       name TEXT NOT NULL,
       target_at INTEGER NOT NULL,
       created_by TEXT NOT NULL,
       created_at INTEGER NOT NULL DEFAULT (unixepoch())
     )`,
  ).run();
}

const SCHEMA = {
  type: "object",
  properties: {
    target_at: { type: "string", description: "The moment the countdown ends, as ISO 8601 with the UTC offset" },
    missing_info: {
      type: ["string", "null"],
      description: "If no usable date was given, say what's missing. Otherwise null.",
    },
  },
  required: ["target_at", "missing_info"],
};

/** "116 days", "1 day, 4 hours", "5h 23m 10s", "42s". */
export function formatRemaining(ms) {
  if (ms <= 0) return "now";
  const s = Math.floor(ms / 1000);
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  if (days >= 2) return `${days} days`;
  if (days === 1) return hours ? `1 day, ${hours} hour${hours === 1 ? "" : "s"}` : "1 day";
  if (hours) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/** One line per countdown; the <t:…:R> part keeps ticking live in Discord. */
export function countdownLine(row, now = Date.now()) {
  const target = new Date(row.target_at * 1000);
  const left = target.getTime() - now;
  const icon = left < DAY ? "⏳" : "📅";
  return `${icon} **${row.name}**: ${formatRemaining(left)} left · ${discordTimestamp(target, "f")} (${discordTimestamp(target, "R")})`;
}

async function parseWhen(env, text) {
  const timeZone = env.TIMEZONE || "America/New_York";
  const parsed = await extractStructured(env, {
    system: `You turn a casual date or time into an exact moment for a countdown. ${describeNow(timeZone)}
Interpret times in ${timeZone} unless another zone is stated. If only a day is given with no time, use 12:00 AM (the start of that day).
A day without a year means its next occurrence.`,
    prompt: text,
    toolName: "set_countdown",
    description: "Set when the countdown ends",
    schema: SCHEMA,
  });
  if (parsed.missing_info) throw new UserFacingError(`🤔 I couldn't set that countdown: ${parsed.missing_info}`);
  const when = new Date(parsed.target_at);
  if (Number.isNaN(when.getTime())) {
    throw new UserFacingError('🤔 I couldn\'t figure out when that is. Try something like "March 14" or "Friday at 6pm".');
  }
  if (when.getTime() <= Date.now()) throw new UserFacingError(`🤔 That time (${discordTimestamp(when)}) has already passed.`);
  if (when.getTime() - Date.now() > MAX_AHEAD) throw new UserFacingError("🤔 Countdowns can be up to 5 years ahead.");
  return when;
}

async function listRows(env, guildId) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM countdowns WHERE guild_id = ? ORDER BY target_at LIMIT ?",
  )
    .bind(guildId, MAX_PER_SERVER)
    .all();
  return results;
}

/**
 * The countdowns that can be shown in `channelId`: its own, plus ones from
 * channels everyone in the server can read. Threads follow their parent,
 * private threads are private, and a channel that's gone or can't be read
 * counts as private, so a private channel's countdown never shows up in
 * another channel.
 */
async function visibleRows(env, guildId, channelId, rows) {
  rows ??= await listRows(env, guildId);
  if (rows.every((r) => r.channel_id === channelId)) return rows;
  let guild;
  let channels;
  try {
    [guild, channels] = await Promise.all([
      discordApi(env, `/guilds/${guildId}`),
      discordApi(env, `/guilds/${guildId}/channels`),
    ]);
  } catch (err) {
    console.warn("Couldn't check which countdown channels are public; showing only this channel's:", err.message);
    return rows.filter((r) => r.channel_id === channelId);
  }
  const byId = new Map(channels.map((c) => [c.id, c]));
  const publicIds = new Set([channelId]);
  for (const id of new Set(rows.map((r) => r.channel_id))) {
    if (publicIds.has(id)) continue;
    // The channel list leaves out threads, so look those up one by one.
    const channel = byId.get(id) ?? (await discordApi(env, `/channels/${id}`).catch(() => null));
    if (!channel || channel.type === PRIVATE_THREAD) continue;
    const source = THREAD_TYPES.has(channel.type) ? byId.get(channel.parent_id) : channel;
    if (source && isPublicChannel(guild, source)) publicIds.add(id);
  }
  return rows.filter((r) => publicIds.has(r.channel_id));
}

async function findByName(env, guildId, channelId, name) {
  const all = await listRows(env, guildId);
  const rows = await visibleRows(env, guildId, channelId, all);
  const wanted = String(name ?? "").trim().toLowerCase();
  const exact = (r) => r.name.toLowerCase() === wanted;
  // An exact name that's hidden from here never falls through to a partial
  // match, so removing "Party" can't delete a visible "Party planning".
  if (all.some(exact)) return rows.find(exact) ?? null;
  return rows.find((r) => r.name.toLowerCase().includes(wanted));
}

export async function countdown(interaction, env) {
  if (!interaction.guild_id) throw new UserFacingError("Countdowns only work inside a server.");
  await ensureCountdownTable(env);
  const action = getSubcommand(interaction) ?? "list";
  const guildId = interaction.guild_id;
  const me = invokingUser(interaction);
  const reply = (content) => editOriginal(env, interaction, { content, allowed_mentions: NO_MENTIONS });

  if (action === "add") {
    const name = String(getOption(interaction, "name") ?? "").trim().slice(0, 100);
    if (!name) throw new UserFacingError("Give the countdown a name, like \"Japan trip\".");
    const rows = await listRows(env, guildId);
    if (rows.length >= MAX_PER_SERVER) {
      throw new UserFacingError(`This server already has ${MAX_PER_SERVER} countdowns. Remove one with \`/countdown remove\` first.`);
    }
    if (rows.some((r) => r.name.toLowerCase() === name.toLowerCase())) {
      throw new UserFacingError(`There's already a countdown called **${name}**. Pick another name or remove that one first.`);
    }
    const when = await parseWhen(env, getOption(interaction, "when"));
    const row = { name, target_at: Math.floor(when.getTime() / 1000) };
    await env.DB.prepare(
      "INSERT INTO countdowns (guild_id, channel_id, name, target_at, created_by) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(guildId, interaction.channel_id, name, row.target_at, me.id)
      .run();
    await reply(`⏳ Countdown started!\n${countdownLine(row)}\nI'll post here when the time comes.`);
    return;
  }

  if (action === "remove") {
    const row = await findByName(env, guildId, interaction.channel_id, getOption(interaction, "name"));
    if (!row) throw new UserFacingError("I couldn't find a countdown with that name. See them all with `/countdown list`.");
    if (row.created_by !== me.id && !canManageChannels(interaction)) {
      throw new UserFacingError("🔒 Only the person who started a countdown, or someone who can manage channels, can remove it.");
    }
    await env.DB.prepare("DELETE FROM countdowns WHERE id = ?").bind(row.id).run();
    await reply(`🗑️ Removed the **${row.name}** countdown.`);
    return;
  }

  // list (also shows one countdown when a name is given)
  const name = getOption(interaction, "name");
  if (name) {
    const row = await findByName(env, guildId, interaction.channel_id, name);
    if (!row) throw new UserFacingError("I couldn't find a countdown with that name. See them all with `/countdown list`.");
    await reply(countdownLine(row));
    return;
  }
  const rows = await visibleRows(env, guildId, interaction.channel_id);
  if (!rows.length) {
    await reply('No countdowns yet. Start one with `/countdown add name:"Japan trip" when:"March 14"`.');
    return;
  }
  await reply(`**Countdowns**\n${rows.map((r) => countdownLine(r)).join("\n")}`);
}

/** Runs every minute: posts an alert for each countdown that has hit zero. */
export async function postDueCountdowns(env, { limit = 10 } = {}) {
  await ensureCountdownTable(env);
  const now = Math.floor(Date.now() / 1000);
  const { results } = await env.DB.prepare(
    "SELECT * FROM countdowns WHERE target_at <= ? ORDER BY target_at LIMIT ?",
  )
    .bind(now, limit)
    .all();

  for (const row of results) {
    // Claim it first so an overlapping run can't post it twice.
    const claimed = await env.DB.prepare("DELETE FROM countdowns WHERE id = ?").bind(row.id).run();
    if (claimed.meta?.changes === 0) continue;
    try {
      await sendChannelMessage(env, row.channel_id, {
        content: `<@${row.created_by}>`,
        embeds: [
          {
            title: `🎉 It's time: ${row.name}!`,
            description: `The countdown is over. ${discordTimestamp(new Date(row.target_at * 1000), "F")} is here.`,
            color: 0xff4fa3,
          },
        ],
        allowed_mentions: { users: [row.created_by] },
      });
    } catch (err) {
      const permanent = err.status >= 400 && err.status < 500;
      if (permanent || now - row.target_at > GIVE_UP_AFTER) {
        console.error(`Countdown ${row.id} alert could not be posted, dropping it:`, err.message);
        continue;
      }
      console.warn(`Countdown ${row.id} alert could not be posted, will retry:`, err.message);
      await env.DB.prepare(
        "INSERT INTO countdowns (guild_id, channel_id, name, target_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
        .bind(row.guild_id, row.channel_id, row.name, row.target_at, row.created_by, row.created_at)
        .run();
    }
  }
}
