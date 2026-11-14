// /digest: a short daily digest posted to a channel on a schedule.

import { describeNow, webSearch } from "../claude.js";
import {
  NO_MENTIONS,
  UserFacingError,
  canManageChannels,
  editOriginal,
  getOption,
  getSubcommand,
  sendChannelMessage,
} from "../discord.js";
import { formatTime, initialLastSent, isDue, localNow, parseTime } from "../schedule.js";

const MAX_BULLETS = 5;
const DEFAULT_TIME = "8am";

const SYSTEM = (timeZone) => `You write a very short daily digest for a Discord channel. ${describeNow(timeZone)}
Search the web for what's new or happening today on the given topics, then reply with ONLY bullet points:
- at most ${MAX_BULLETS} bullets, most important first, at least one per topic when there's something worth sharing
- each bullet is one line, under 15 words
- make the key phrase of each bullet a link to its source, written as [phrase](<url>)
No intro, no headings, no sign-off, no commentary. Skip a topic if there's nothing notable.
Never use @everyone or @here.`;

async function ensureTable(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS digests (
       channel_id TEXT PRIMARY KEY,
       guild_id TEXT,
       topics TEXT NOT NULL,
       hour INTEGER NOT NULL,
       minute INTEGER NOT NULL,
       last_sent TEXT,
       created_by TEXT,
       created_at INTEGER NOT NULL DEFAULT (unixepoch())
     )`,
  ).run();
}

/** Keep only bullet lines, at most MAX_BULLETS of them. */
export function tidyDigest(text) {
  const bullets = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[-•*]\s+/.test(line))
    .map((line) => `• ${line.replace(/^[-•*]\s+/, "")}`)
    .slice(0, MAX_BULLETS);
  return bullets.join("\n");
}

/** Build the digest text for some topics. */
export async function buildDigest(env, topics) {
  const timeZone = env.TIMEZONE || "America/New_York";
  const { text } = await webSearch(env, {
    system: SYSTEM(timeZone),
    prompt: `Topics: ${topics}`,
    maxSearches: 3,
  });
  const bullets = tidyDigest(text);
  const today = new Date().toLocaleDateString("en-US", { timeZone, weekday: "short", month: "short", day: "numeric" });
  return `☀️ **Daily digest** · ${today}\n${bullets || "Quiet day: nothing notable on these topics."}`.slice(0, 1990);
}

export async function digest(interaction, env) {
  const action = getSubcommand(interaction) ?? "list";
  const timeZone = env.TIMEZONE || "America/New_York";
  await ensureTable(env);
  const reply = (content) => editOriginal(env, interaction, { content, allowed_mentions: NO_MENTIONS });

  if ((action === "setup" || action === "off") && !canManageChannels(interaction)) {
    throw new UserFacingError("🔒 Only people who can manage channels can set up or stop digests.");
  }

  if (action === "setup") {
    const channelId = getOption(interaction, "channel") ?? interaction.channel_id;
    const topics = getOption(interaction, "topics").trim();
    const time = parseTime(getOption(interaction, "time") ?? DEFAULT_TIME);
    const lastSent = initialLastSent({ frequency: "daily", ...time }, localNow(timeZone));
    await env.DB.prepare(
      `INSERT INTO digests (channel_id, guild_id, topics, hour, minute, last_sent, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(channel_id) DO UPDATE SET topics = excluded.topics, hour = excluded.hour,
         minute = excluded.minute, last_sent = excluded.last_sent`,
    )
      .bind(channelId, interaction.guild_id ?? null, topics, time.hour, time.minute, lastSent, interaction.member?.user?.id ?? null)
      .run();
    await reply(
      `☀️ Daily digest set for <#${channelId}> at **${formatTime(time)}** (${timeZone.replace("_", " ")}).\n` +
        `Topics: ${topics}\nRun \`/digest now\` to preview it.`,
    );
    return;
  }

  if (action === "off") {
    const channelId = getOption(interaction, "channel") ?? interaction.channel_id;
    const { meta } = await env.DB.prepare("DELETE FROM digests WHERE channel_id = ?").bind(channelId).run();
    await reply(meta?.changes === 0 ? `There's no digest set up for <#${channelId}>.` : `🛑 Stopped the daily digest in <#${channelId}>.`);
    return;
  }

  if (action === "now") {
    // Preview here: given topics, or the ones saved for this channel.
    let topics = getOption(interaction, "topics");
    if (!topics) {
      const saved = await env.DB.prepare("SELECT topics FROM digests WHERE channel_id = ?").bind(interaction.channel_id).first();
      topics = saved?.topics;
    }
    if (!topics) throw new UserFacingError("🤔 Tell me what to cover, like `/digest now topics:NYC events, AI news`.");
    await reply(await buildDigest(env, topics));
    return;
  }

  // list
  const { results } = await env.DB.prepare("SELECT * FROM digests WHERE guild_id = ? OR channel_id = ?")
    .bind(interaction.guild_id ?? "", interaction.channel_id)
    .all();
  await reply(
    results.length
      ? `☀️ **Daily digests**\n${results.map((d) => `<#${d.channel_id}> at ${formatTime(d)}: ${d.topics}`).join("\n")}`
      : "No daily digests yet. Someone who can manage channels can run `/digest setup`.",
  );
}

/** Post digests that are due. Runs from the 5-minute cron. */
export async function postDueDigests(env, { limit = 5, now = localNow(env.TIMEZONE || "America/New_York") } = {}) {
  if (!env.DB) return 0;
  await ensureTable(env);
  const { results } = await env.DB.prepare("SELECT * FROM digests").all();
  const due = results.filter((d) => isDue({ frequency: "daily", ...d }, now)).slice(0, limit);
  for (const d of due) {
    // Claim it first so an overlapping run can't post it twice.
    await env.DB.prepare("UPDATE digests SET last_sent = ? WHERE channel_id = ?").bind(now.date, d.channel_id).run();
    try {
      await sendChannelMessage(env, d.channel_id, { content: await buildDigest(env, d.topics), allowed_mentions: NO_MENTIONS });
    } catch (err) {
      console.error(`Daily digest for ${d.channel_id} failed:`, err);
      if (err.status === 403 || err.status === 404) {
        await env.DB.prepare("DELETE FROM digests WHERE channel_id = ?").bind(d.channel_id).run();
      }
    }
  }
  return due.length;
}
