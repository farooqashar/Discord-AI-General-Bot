// /birthday: save birthdays (month and day only) and post a wish on the day.

import { extractStructured } from "../claude.js";
import {
  NO_MENTIONS,
  UserFacingError,
  canManageChannels,
  editOriginal,
  getOption,
  getSubcommand,
  invokingUser,
  sendChannelMessage,
} from "../discord.js";
import { formatTime, initialLastSent, isDue, localNow, parseScheduleTime } from "../schedule.js";

const DEFAULT_TIME = "9am";
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]; // Feb 29 allowed
const MAX_WISHES_PER_POST = 10;

async function ensureTables(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS birthdays (
       guild_id TEXT NOT NULL,
       user_id TEXT NOT NULL,
       name TEXT,
       month INTEGER NOT NULL,
       day INTEGER NOT NULL,
       added_by TEXT,
       created_at INTEGER NOT NULL DEFAULT (unixepoch()),
       PRIMARY KEY (guild_id, user_id)
     )`,
  ).run();
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS birthday_settings (
       guild_id TEXT PRIMARY KEY,
       channel_id TEXT NOT NULL,
       hour INTEGER NOT NULL,
       minute INTEGER NOT NULL,
       last_sent TEXT
     )`,
  ).run();
}

/** "9/27", "09-27", "Sep 27", "September 27th", "27 Sep" → { month, day }. */
export function parseBirthday(text) {
  const t = String(text ?? "").trim().toLowerCase().replace(/(\d)(st|nd|rd|th)\b/, "$1");
  let month;
  let day;
  let m = t.match(/^(\d{1,2})\s*[/\-.]\s*(\d{1,2})$/);
  if (m) {
    month = Number(m[1]);
    day = Number(m[2]);
  } else if ((m = t.match(/^([a-z]+)\.?\s+(\d{1,2})$/))) {
    month = MONTHS.indexOf(m[1].slice(0, 3)) + 1;
    day = Number(m[2]);
  } else if ((m = t.match(/^(\d{1,2})\s+([a-z]+)\.?$/))) {
    month = MONTHS.indexOf(m[2].slice(0, 3)) + 1;
    day = Number(m[1]);
  }
  if (!month || month < 1 || month > 12 || !day || day < 1 || day > DAYS_IN_MONTH[month - 1]) {
    throw new UserFacingError(`🤔 I couldn't read "${text}" as a birthday. Try "9/27" or "Sep 27" (no year needed).`);
  }
  return { month, day };
}

export const formatBirthday = ({ month, day }) =>
  `${MONTHS[month - 1][0].toUpperCase()}${MONTHS[month - 1].slice(1)} ${day}`;

const isLeapYear = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/** Birthdays to celebrate on a local date; Feb 29 birthdays get Feb 28 in other years. */
export function birthdaysOn(rows, date) {
  const [y, mo, d] = date.split("-").map(Number);
  return rows.filter(
    (r) => (r.month === mo && r.day === d) || (r.month === 2 && r.day === 29 && mo === 2 && d === 28 && !isLeapYear(y)),
  );
}

/** Days from `today` (YYYY-MM-DD) until a month/day comes around again. */
function daysUntil(today, { month, day }) {
  const [y, mo, d] = today.split("-").map(Number);
  const now = Date.UTC(y, mo - 1, d);
  let next = Date.UTC(y, month - 1, Math.min(day, month === 2 && !isLeapYear(y) ? 28 : day));
  if (next < now) next = Date.UTC(y + 1, month - 1, Math.min(day, month === 2 && !isLeapYear(y + 1) ? 28 : day));
  return Math.round((next - now) / 86400000);
}

export async function birthday(interaction, env) {
  const action = getSubcommand(interaction) ?? "list";
  const timeZone = env.TIMEZONE || "America/New_York";
  if (!interaction.guild_id) throw new UserFacingError("Birthdays only work inside a server.");
  await ensureTables(env);
  const reply = (content) => editOriginal(env, interaction, { content, allowed_mentions: NO_MENTIONS });
  const me = invokingUser(interaction);

  // Setting or removing someone else's birthday, or choosing the channel, is for admins.
  const targetId = getOption(interaction, "user") ?? me.id;
  const forSomeoneElse = targetId !== me.id;
  if ((forSomeoneElse || action === "channel") && !canManageChannels(interaction)) {
    throw new UserFacingError(
      action === "channel"
        ? "🔒 Only people who can manage channels can choose where birthday wishes go."
        : "🔒 You can only change your own birthday. People who can manage channels can set it for others.",
    );
  }

  if (action === "set") {
    const date = parseBirthday(getOption(interaction, "date"));
    const resolved = interaction.data.resolved;
    const name = forSomeoneElse
      ? resolved?.members?.[targetId]?.nick ?? resolved?.users?.[targetId]?.global_name ?? resolved?.users?.[targetId]?.username
      : interaction.member?.nick ?? me.global_name ?? me.username;
    if (forSomeoneElse && resolved?.users?.[targetId]?.bot) throw new UserFacingError("🤖 Bots don't have birthdays (sadly).");
    await env.DB.prepare(
      `INSERT INTO birthdays (guild_id, user_id, name, month, day, added_by) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(guild_id, user_id) DO UPDATE SET name = excluded.name, month = excluded.month, day = excluded.day`,
    )
      .bind(interaction.guild_id, targetId, name ?? null, date.month, date.day, me.id)
      .run();
    const settings = await env.DB.prepare("SELECT channel_id FROM birthday_settings WHERE guild_id = ?").bind(interaction.guild_id).first();
    await reply(
      `🎂 Saved ${forSomeoneElse ? `<@${targetId}>'s` : "your"} birthday as **${formatBirthday(date)}**.` +
        (settings ? "" : "\n⚠️ No birthday channel yet; someone who can manage channels can run `/birthday channel`."),
    );
    return;
  }

  if (action === "remove") {
    const { meta } = await env.DB.prepare("DELETE FROM birthdays WHERE guild_id = ? AND user_id = ?")
      .bind(interaction.guild_id, targetId)
      .run();
    const whose = forSomeoneElse ? `<@${targetId}>'s` : "your";
    await reply(meta?.changes === 0 ? `There's no saved birthday for ${forSomeoneElse ? `<@${targetId}>` : "you"}.` : `🗑️ Removed ${whose} birthday.`);
    return;
  }

  if (action === "channel") {
    const channelId = getOption(interaction, "channel") ?? interaction.channel_id;
    const time = parseScheduleTime(getOption(interaction, "time") ?? DEFAULT_TIME);
    const lastSent = initialLastSent({ frequency: "daily", ...time }, localNow(timeZone));
    await env.DB.prepare(
      `INSERT INTO birthday_settings (guild_id, channel_id, hour, minute, last_sent) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(guild_id) DO UPDATE SET channel_id = excluded.channel_id, hour = excluded.hour,
         minute = excluded.minute, last_sent = excluded.last_sent`,
    )
      .bind(interaction.guild_id, channelId, time.hour, time.minute, lastSent)
      .run();
    await reply(`🎂 Birthday wishes will go in <#${channelId}> at **${formatTime(time)}** on the day.`);
    return;
  }

  // list: upcoming birthdays, soonest first. Shown without pinging anyone.
  const { results } = await env.DB.prepare("SELECT * FROM birthdays WHERE guild_id = ?").bind(interaction.guild_id).all();
  const settings = await env.DB.prepare("SELECT * FROM birthday_settings WHERE guild_id = ?").bind(interaction.guild_id).first();
  if (!results.length) {
    await reply("No birthdays saved yet. Add yours with `/birthday set date:9/27`.");
    return;
  }
  const today = localNow(timeZone).date;
  const upcoming = results
    .map((r) => ({ ...r, inDays: daysUntil(today, r) }))
    .sort((a, b) => a.inDays - b.inDays)
    .slice(0, 15);
  const when = (n) => (n === 0 ? "**today** 🎉" : n === 1 ? "tomorrow" : `in ${n} days`);
  await reply(
    `🎂 **Upcoming birthdays**${settings ? ` (wishes in <#${settings.channel_id}>)` : ""}\n` +
      upcoming.map((r) => `${formatBirthday(r)} · <@${r.user_id}> · ${when(r.inDays)}`).join("\n"),
  );
}

/** Post today's birthday wishes. Runs from the 5-minute cron. */
export async function postDueBirthdays(env, { limit = 5, now = localNow(env.TIMEZONE || "America/New_York") } = {}) {
  if (!env.DB) return 0;
  await ensureTables(env);
  const { results: servers } = await env.DB.prepare("SELECT * FROM birthday_settings").all();
  const due = servers.filter((s) => isDue({ frequency: "daily", ...s }, now)).slice(0, limit);

  let posted = 0;
  for (const s of due) {
    // Claim the day first so an overlapping run can't wish twice.
    await env.DB.prepare("UPDATE birthday_settings SET last_sent = ? WHERE guild_id = ?").bind(now.date, s.guild_id).run();
    const { results } = await env.DB.prepare("SELECT * FROM birthdays WHERE guild_id = ?").bind(s.guild_id).all();
    const people = birthdaysOn(results, now.date).slice(0, MAX_WISHES_PER_POST);
    if (!people.length) continue;

    const mentions = people.map((p) => `<@${p.user_id}>`);
    const names = mentions.length > 1 ? `${mentions.slice(0, -1).join(", ")} and ${mentions.at(-1)}` : mentions[0];
    let line = "Hope it's a great one! 🎉";
    try {
      const { wish } = await extractStructured(env, {
        system:
          "You write one short, warm, playful birthday wish for a Discord group chat: one sentence, under 20 words, " +
          "with an emoji. Don't mention age, and don't use anyone's name (it's added separately).",
        prompt: `Write a birthday wish for ${people.length === 1 ? "one friend" : `${people.length} friends`} (${people.map((p) => p.name || "a friend").join(", ")}).`,
        toolName: "wish",
        description: "A birthday wish",
        schema: { type: "object", properties: { wish: { type: "string" } }, required: ["wish"] },
      });
      if (wish?.trim()) line = wish.trim();
    } catch (err) {
      console.warn("Birthday wish AI step failed; using the default:", err.message);
    }

    try {
      await sendChannelMessage(env, s.channel_id, {
        content: `🎂 Happy birthday ${names}! ${line}`.slice(0, 1990),
        // Ping only the birthday people.
        allowed_mentions: { parse: [], users: people.map((p) => p.user_id) },
      });
      posted++;
    } catch (err) {
      console.error(`Birthday post for server ${s.guild_id} failed:`, err);
    }
  }
  return posted;
}
