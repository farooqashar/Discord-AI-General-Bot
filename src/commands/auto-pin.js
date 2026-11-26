// /auto-pin: once a day, pin the messages in a channel that match a description.
//
// Each night at the set time, the bot reads the last 24 hours of the channel,
// asks the AI which messages clearly match the rule, and pins up to
// `max_pins` of them (default 5, up to 20). The optional report lists jump links only, never
// message text, so a report channel can't leak a private channel's content.

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
  targetChannel,
} from "../discord.js";
import { formatTime, initialLastSent, isDue, localNow, parseScheduleTime } from "../schedule.js";
import { hiddenNote, visibleRows } from "../visibility.js";

const DEFAULT_TIME = "11pm";
export const DEFAULT_MAX_PINS = 5;
// Each pin is its own request, and a scheduled run gets 50, so cap it here.
export const MAX_PINS_LIMIT = 20;
const SCAN_MESSAGES = 300;
const WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_PINS_ERROR = 30003; // Discord: "Maximum number of pins reached"

const schema = (max) => ({
  type: "object",
  properties: {
    indexes: {
      type: "array",
      items: { type: "integer" },
      maxItems: max,
      description: `Indexes of messages that clearly match, best first (at most ${max}; empty if none match)`,
    },
  },
  required: ["indexes"],
});

const clampMax = (n) => Math.min(MAX_PINS_LIMIT, Math.max(1, Number(n) || DEFAULT_MAX_PINS));

async function ensureTable(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS auto_pins (
       channel_id TEXT PRIMARY KEY,
       guild_id TEXT,
       rule TEXT NOT NULL,
       hour INTEGER NOT NULL,
       minute INTEGER NOT NULL,
       report_channel_id TEXT,
       last_sent TEXT,
       created_by TEXT,
       created_at INTEGER NOT NULL DEFAULT (unixepoch())
     )`,
  ).run();
  // Tables made before the daily limit was adjustable lack this column.
  await env.DB.prepare("ALTER TABLE auto_pins ADD COLUMN max_pins INTEGER").run().catch(() => {});
}

const short = (text, n) => {
  const t = (text || "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** The last day's unpinned, human messages in a channel that match the rule. */
export async function findMatches(env, channelId, rule, maxPins = DEFAULT_MAX_PINS) {
  const max = clampMax(maxPins);
  const since = new Date(Date.now() - WINDOW_MS);
  const history = await fetchHistory(env, channelId, SCAN_MESSAGES, { since });
  const pool = history.filter((m) => !m.author?.bot && !m.pinned && m.content?.trim()).reverse();
  if (!pool.length) return [];

  const { indexes = [] } = await extractStructured(env, {
    system:
      "You pick Discord messages to pin. Only pick messages that clearly and specifically match the description; " +
      "when unsure, leave it out. Never pick anything mean, embarrassing or private. It's fine to pick none.",
    prompt:
      `Pin messages that match: "${rule}"\n\nMessages (index: author: text), oldest first:\n` +
      pool.map((m, i) => `${i}: ${authorName(m)}: ${short(m.content, 300)}`).join("\n"),
    toolName: "pick_messages",
    description: "Choose which messages to pin",
    schema: schema(max),
  });

  const picked = [...new Set(indexes)].filter((i) => Number.isInteger(i) && pool[i]);
  return picked.slice(0, max).map((i) => pool[i]);
}

/** Pin messages; returns which were pinned and whether the channel is full. */
export async function pinAll(env, channelId, messages) {
  const pinned = [];
  for (const m of messages) {
    try {
      await discordApi(env, `/channels/${channelId}/messages/pins/${m.id}`, { method: "PUT" });
      pinned.push(m);
    } catch (err) {
      if (err.status === 403) {
        throw new UserFacingError(
          "📌 I don't have permission to pin there. Re-invite me with the Pin Messages permission (see the README's invite link).",
        );
      }
      if (String(err.message).includes(String(MAX_PINS_ERROR))) return { pinned, full: true };
      console.warn(`Couldn't pin ${m.id} in ${channelId}:`, err.message);
    }
  }
  return { pinned, full: false };
}

const link = (guildId, channelId, id) => `https://discord.com/channels/${guildId}/${channelId}/${id}`;

function describe(p) {
  return `<#${p.channel_id}>: "${p.rule}" at ${formatTime(p)}, up to ${clampMax(p.max_pins)}/day${p.report_channel_id ? `, report in <#${p.report_channel_id}>` : ""}`;
}

export async function autoPin(interaction, env) {
  const action = getSubcommand(interaction) ?? "list";
  const timeZone = env.TIMEZONE || "America/New_York";
  if (!interaction.guild_id) throw new UserFacingError("Auto-pin only works inside a server.");
  await ensureTable(env);
  const reply = (content) => editOriginal(env, interaction, { content, allowed_mentions: NO_MENTIONS });

  if ((action === "setup" || action === "off") && !canManageChannels(interaction)) {
    throw new UserFacingError("🔒 Only people who can manage channels can set up or stop auto-pin.");
  }

  if (action === "setup") {
    const channelId = targetChannel(interaction, "auto-pin");
    const rule = getOption(interaction, "rule").trim();
    const time = parseScheduleTime(getOption(interaction, "time") ?? DEFAULT_TIME);
    const reportChannelId = getOption(interaction, "report") ?? null;
    const maxPins = clampMax(getOption(interaction, "max"));
    const lastSent = initialLastSent({ frequency: "daily", ...time }, localNow(timeZone));
    await env.DB.prepare(
      `INSERT INTO auto_pins (channel_id, guild_id, rule, hour, minute, report_channel_id, last_sent, created_by, max_pins)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(channel_id) DO UPDATE SET rule = excluded.rule, hour = excluded.hour, minute = excluded.minute,
         report_channel_id = excluded.report_channel_id, last_sent = excluded.last_sent, max_pins = excluded.max_pins`,
    )
      .bind(channelId, interaction.guild_id, rule, time.hour, time.minute, reportChannelId, lastSent, interaction.member?.user?.id ?? null, maxPins)
      .run();
    await reply(
      `📌 Every day at **${formatTime(time)}** I'll pin up to ${maxPins} messages from the last 24 hours in <#${channelId}> that match:\n> ${rule}\n` +
        "Run `/auto-pin now` there to preview what I'd pick.",
    );
    return;
  }

  if (action === "off") {
    const channelId = getOption(interaction, "channel") ?? interaction.channel_id;
    const { meta } = await env.DB.prepare("DELETE FROM auto_pins WHERE channel_id = ?").bind(channelId).run();
    await reply(meta?.changes === 0 ? `Auto-pin isn't set up for <#${channelId}>.` : `🛑 Stopped auto-pin in <#${channelId}>. Existing pins stay.`);
    return;
  }

  if (action === "now") {
    // A preview: shows what would be pinned, pins nothing.
    const channelId = targetChannel(interaction, "preview");
    const saved = await env.DB.prepare("SELECT rule, max_pins FROM auto_pins WHERE channel_id = ?").bind(channelId).first();
    const rule = getOption(interaction, "rule") ?? saved?.rule;
    const maxPins = clampMax(getOption(interaction, "max") ?? saved?.max_pins);
    if (!rule) throw new UserFacingError('🤔 Tell me what to look for, like `/auto-pin now rule:"restaurant recs"`.');
    const matches = await findMatches(env, channelId, rule, maxPins);
    await reply(
      matches.length
        ? `📌 **Preview:** I'd pin ${matches.length} from the last 24 hours in <#${channelId}> (nothing was pinned):\n` +
            matches.map((m) => `• "${short(m.content, 80)}" · ${authorName(m)} ${link(interaction.guild_id, channelId, m.id)}`).join("\n")
        : `📌 Nothing from the last 24 hours in <#${channelId}> matches "${rule}".`,
    );
    return;
  }

  // list
  const { results } = await env.DB.prepare("SELECT * FROM auto_pins WHERE guild_id = ?").bind(interaction.guild_id).all();
  // Rules are free text, so a private channel's only show up in that channel.
  const { shown, hidden } = await visibleRows(env, interaction.guild_id, interaction.channel_id, results);
  await reply(
    shown.length
      ? `📌 **Auto-pin**\n${shown.map(describe).join("\n")}${hiddenNote(hidden, "auto-pin")}`
      : hidden
        ? `No auto-pins to show here.${hiddenNote(hidden, "auto-pin")}`
        : "Auto-pin isn't set up anywhere yet. Someone who can manage channels can run `/auto-pin setup`.",
  );
}

/**
 * Run the auto-pins that are due, one per run: with up to 20 pins, one can use
 * about 25 of the run's 50 requests. Others go out on the next 5-minute run.
 */
export async function runDueAutoPins(env, { limit = 1, now = localNow(env.TIMEZONE || "America/New_York") } = {}) {
  if (!env.DB) return 0;
  await ensureTable(env);
  const { results } = await env.DB.prepare("SELECT * FROM auto_pins").all();
  const due = results.filter((p) => isDue({ frequency: "daily", ...p }, now)).slice(0, limit);

  for (const p of due) {
    // Claim it first so an overlapping run can't pin twice.
    await env.DB.prepare("UPDATE auto_pins SET last_sent = ? WHERE channel_id = ?").bind(now.date, p.channel_id).run();
    try {
      const matches = await findMatches(env, p.channel_id, p.rule, p.max_pins);
      if (!matches.length) continue;
      const { pinned, full } = await pinAll(env, p.channel_id, matches);
      if (p.report_channel_id && (pinned.length || full)) {
        const lines = [`📌 Pinned ${pinned.length} message${pinned.length === 1 ? "" : "s"} in <#${p.channel_id}> today:`];
        lines.push(...pinned.map((m) => link(p.guild_id, p.channel_id, m.id)));
        if (full) lines.push("⚠️ That channel hit Discord's 250-pin limit; unpin some to keep auto-pin working.");
        await sendChannelMessage(env, p.report_channel_id, { content: lines.join("\n"), allowed_mentions: NO_MENTIONS });
      }
    } catch (err) {
      console.error(`Auto-pin for ${p.channel_id} failed:`, err);
      if (err.status === 404) await env.DB.prepare("DELETE FROM auto_pins WHERE channel_id = ?").bind(p.channel_id).run();
    }
  }
  return due.length;
}
