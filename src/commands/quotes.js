// The Quote Book: saves every quote posted in a server's quotes channel, so
// they never scroll away, and serves them back in Discord and on a website
// (src/web/quotes-site.js) that only the server's members can open.
//
// - /quotes setup channel:#quotes imports the recent history.
// - Every 5 minutes the bot reads the newest messages, saves new quotes
//   (a free pattern check first, the AI for messier ones), refreshes ⭐ counts,
//   and pins quotes that reach STAR_PIN_THRESHOLD ⭐ (the hall of fame).

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
} from "../discord.js";
import { isPublicChannel } from "./stats.js";

export const STAR_PIN_THRESHOLD = 3;
const BACKFILL_MESSAGES = 500;
const AI_BATCH = 40;

export async function ensureQuoteTables(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS quote_books (
       guild_id TEXT PRIMARY KEY,
       guild_name TEXT,
       channel_id TEXT NOT NULL,
       last_message_id TEXT,
       created_by TEXT,
       created_at INTEGER NOT NULL DEFAULT (unixepoch())
     )`,
  ).run();
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS quotes (
       message_id TEXT PRIMARY KEY,
       guild_id TEXT NOT NULL,
       channel_id TEXT NOT NULL,
       text TEXT NOT NULL,
       speaker TEXT,
       speaker_id TEXT,
       poster_id TEXT,
       poster_name TEXT,
       posted_at INTEGER NOT NULL,
       stars INTEGER NOT NULL DEFAULT 0,
       reactions INTEGER NOT NULL DEFAULT 0,
       pinned INTEGER NOT NULL DEFAULT 0
     )`,
  ).run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_quotes_guild ON quotes (guild_id, posted_at)").run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_quotes_speaker ON quotes (guild_id, speaker_id)").run();
}

const OPEN = `"“„«`;
const CLOSE = `"”»`;
// "quote" - Name / "quote" — @user / "quote" ~Name / "quote" by Name / "quote"
const QUOTE_FIRST = new RegExp(`^\\s*[${OPEN}]([\\s\\S]+?)[${CLOSE}]\\s*(?:(?:[-–—~]+|by\\b)\\s*(.*))?$`, "i");
// Name: "quote" / Name - "quote"
const SPEAKER_FIRST = new RegExp(`^\\s*([^\\n"“„«:]{1,40}?)\\s*[:\\-–—]\\s*[${OPEN}]([\\s\\S]+?)[${CLOSE}]\\s*$`);

function cleanSpeaker(raw) {
  const s = (raw ?? "").trim().replace(/^[-–—~@\s]+/, "").replace(/[.,;!]+$/, "").trim();
  return s && s.length <= 60 && !s.includes("\n") ? s : null;
}

/**
 * A quote by pattern, or null. Free; catches the common formats.
 * `mentions` is the message's mentioned users, used to turn <@id> into names.
 */
export function detectQuote(content, mentions = []) {
  const text = (content ?? "").trim();
  if (text.length < 4) return null;
  let m = text.match(QUOTE_FIRST);
  if (m) {
    const rest = (m[2] ?? "").trim();
    // Lots of text after the closing quote means it isn't just an attribution.
    if (rest && !cleanSpeaker(rest)) return null;
    return withMention({ text: m[1].trim(), speaker: cleanSpeaker(rest) }, mentions);
  }
  m = text.match(SPEAKER_FIRST);
  if (m) return withMention({ text: m[2].trim(), speaker: cleanSpeaker(m[1]) }, mentions);
  return null;
}

const mentionName = (u) => u.member?.nick ?? u.global_name ?? u.username ?? null;

/**
 * Store names, not raw <@id> mentions: the speaker becomes the person's display
 * name (their ID stays in speakerId for pings), and mentions in the text become
 * @Name. A mention we can't name leaves the speaker empty rather than "<@id>".
 */
function withMention(q, mentions = []) {
  const names = new Map((mentions ?? []).map((u) => [u.id, mentionName(u)]));
  const mention = q.speaker?.match(/^<@!?(\d+)>$/);
  const speakerId = mention ? mention[1] : null;
  return {
    text: q.text.replace(/<@!?(\d+)>/g, (raw, id) => (names.get(id) ? `@${names.get(id)}` : raw)),
    speaker: speakerId ? names.get(speakerId) ?? null : q.speaker,
    speakerId,
  };
}

// A speaker stored as the bare mention of its own speaker_id, like "<@42>".
const RAW_SPEAKER = (t) => `${t}.speaker IN ('<@' || ${t}.speaker_id || '>', '<@!' || ${t}.speaker_id || '>')`;
const REPAIR_BATCH = 200;

/**
 * Older quotes were saved with "<@id>" as the speaker. Give them, and quotes
 * whose mention couldn't be named, the name the same person has on another
 * quote. Raw mentions with no name yet become Unknown but keep speaker_id, so
 * a later name still reaches them. Compound speakers ("<@42> and Jo") have no
 * speaker_id and are left alone. Each pass handles at most REPAIR_BATCH rows.
 */
export async function fixMentionSpeakers(env, guildId) {
  const named = `SELECT q2.speaker FROM quotes q2
       WHERE q2.guild_id = quotes.guild_id AND q2.speaker_id = quotes.speaker_id
         AND q2.speaker IS NOT NULL AND q2.speaker <> '<@' || q2.speaker_id || '>' AND q2.speaker <> '<@!' || q2.speaker_id || '>'`;
  await env.DB.prepare(
    `UPDATE quotes SET speaker = (${named} ORDER BY q2.posted_at DESC LIMIT 1)
     WHERE message_id IN (
       SELECT message_id FROM quotes WHERE guild_id = ? AND speaker_id IS NOT NULL
         AND (speaker IS NULL OR ${RAW_SPEAKER("quotes")}) AND EXISTS (${named})
       LIMIT ${REPAIR_BATCH})`,
  )
    .bind(guildId)
    .run();
  await env.DB.prepare(
    `UPDATE quotes SET speaker = NULL
     WHERE message_id IN (
       SELECT message_id FROM quotes WHERE guild_id = ? AND speaker_id IS NOT NULL AND ${RAW_SPEAKER("quotes")}
       LIMIT ${REPAIR_BATCH})`,
  )
    .bind(guildId)
    .run();
}

const QUOTE_SCHEMA = {
  type: "object",
  properties: {
    quotes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "integer" },
          text: { type: "string", description: "Just the words that were said" },
          speaker: { type: ["string", "null"], description: "Who said it, as written, or null" },
        },
        required: ["index", "text", "speaker"],
      },
    },
  },
  required: ["quotes"],
};

/** Ask the AI which of these messages record something someone said. */
async function aiQuotes(env, messages) {
  if (!messages.length) return [];
  const { quotes = [] } = await extractStructured(env, {
    system:
      "These messages come from a Discord channel where friends save funny or memorable things people said. " +
      "Return only messages that record something someone said, with the quote text and who said it if the message says. " +
      "Skip ordinary chatter, questions to the group, reactions and links. Never invent a speaker.",
    prompt: messages.map((m, i) => `${i}: ${authorName(m)} posted: ${m.content.slice(0, 500)}`).join("\n"),
    toolName: "save_quotes",
    description: "The messages that are quotes",
    schema: QUOTE_SCHEMA,
  });
  return quotes
    .filter((q) => Number.isInteger(q.index) && messages[q.index] && q.text?.trim())
    .map((q) => ({ message: messages[q.index], quote: withMention({ text: q.text.trim(), speaker: cleanSpeaker(q.speaker) }, messages[q.index].mentions) }));
}

const starCount = (m) => (m.reactions ?? []).find((r) => r.emoji?.name === "⭐")?.count ?? 0;
const reactionCount = (m) => (m.reactions ?? []).reduce((s, r) => s + (r.count ?? 0), 0);

/**
 * Find the quotes among some messages: patterns first, the AI for the rest.
 * `failed` lists the messages whose AI check failed, so a later sync can retry them.
 */
export async function extractQuotes(env, messages) {
  const candidates = messages.filter((m) => !m.author?.bot && m.content?.trim() && !m.content.trim().startsWith("/"));
  const found = [];
  const leftovers = [];
  for (const m of candidates) {
    const quote = detectQuote(m.content, m.mentions);
    if (quote) found.push({ message: m, quote });
    else if (m.content.trim().length <= 500) leftovers.push(m);
  }
  const batches = [];
  for (let i = 0; i < leftovers.length; i += AI_BATCH) batches.push(leftovers.slice(i, i + AI_BATCH));
  const failed = [];
  const results = await Promise.all(
    batches.map((b) =>
      aiQuotes(env, b).catch((err) => {
        console.warn("Quote AI check failed; keeping pattern matches only:", err.message);
        failed.push(...b);
        return [];
      }),
    ),
  );
  return { found: [...found, ...results.flat()], failed };
}

async function saveQuotes(env, guildId, channelId, found) {
  for (const { message: m, quote } of found) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO quotes
         (message_id, guild_id, channel_id, text, speaker, speaker_id, poster_id, poster_name, posted_at, stars, reactions, pinned)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        m.id,
        guildId,
        channelId,
        quote.text.slice(0, 1000),
        quote.speaker,
        quote.speakerId,
        m.author?.id ?? null,
        authorName(m),
        new Date(m.timestamp).getTime(),
        starCount(m),
        reactionCount(m),
        m.pinned ? 1 : 0,
      )
      .run();
    // Re-imports (/quotes setup) repair quotes saved before mentions were named.
    if (quote.speakerId || /<@!?\d+>/.test(m.content)) {
      await env.DB.prepare(
        `UPDATE quotes SET text = ?, speaker = ?, speaker_id = ?
         WHERE message_id = ? AND (speaker IS NULL OR speaker LIKE '<@%' OR text LIKE '%<@%')`,
      )
        .bind(quote.text.slice(0, 1000), quote.speaker, quote.speakerId, m.id)
        .run();
    }
  }
}

const newestId = (messages) => messages.reduce((max, m) => (BigInt(m.id) > BigInt(max) ? m.id : max), "0");
const oldestId = (messages) => messages.reduce((min, m) => (BigInt(m.id) < BigInt(min) ? m.id : min), messages[0].id);

/** Read a quotes channel's newest messages, save new quotes, refresh stars, pin the best. */
export async function syncQuoteBook(env, book) {
  const recent = await discordApi(env, `/channels/${book.channel_id}/messages?limit=100`);
  if (!recent.length) return { added: 0, pinned: 0 };

  // Claim before the slow part so overlapping runs don't redo it.
  const before = book.last_message_id ?? null;
  const last = before ?? "0";
  const setCursor = (id) => env.DB.prepare("UPDATE quote_books SET last_message_id = ? WHERE guild_id = ?").bind(id, book.guild_id).run();
  await setCursor(newestId(recent));

  const fresh = recent.filter((m) => BigInt(m.id) > BigInt(last));
  let found;
  try {
    let failed;
    ({ found, failed } = await extractQuotes(env, fresh));
    await saveQuotes(env, book.guild_id, book.channel_id, found);
    // Hand messages the AI couldn't check back to the next run. Saving is idempotent, so redoing later ones is harmless.
    if (failed.length) await setCursor(String(BigInt(oldestId(failed)) - 1n));
  } catch (err) {
    await setCursor(before).catch(() => {});
    throw err;
  }
  await fixMentionSpeakers(env, book.guild_id).catch((err) => console.warn(`Couldn't name mentioned speakers in ${book.guild_id}:`, err.message));

  // Refresh reactions on recent quotes, and pin new hall-of-famers.
  let pinned = 0;
  const ids = recent.map((m) => m.id);
  const { results: known } = await env.DB.prepare(
    `SELECT message_id, stars, reactions, pinned FROM quotes WHERE message_id IN (${ids.map(() => "?").join(",")})`,
  )
    .bind(...ids)
    .all();
  const byId = new Map(recent.map((m) => [m.id, m]));
  for (const q of known) {
    const m = byId.get(q.message_id);
    const stars = starCount(m);
    const reactions = reactionCount(m);
    let isPinned = q.pinned || m.pinned ? 1 : 0;
    if (!isPinned && stars >= STAR_PIN_THRESHOLD) {
      try {
        await discordApi(env, `/channels/${book.channel_id}/messages/pins/${m.id}`, { method: "PUT" });
        isPinned = 1;
        pinned++;
      } catch (err) {
        console.warn(`Couldn't pin hall-of-fame quote ${m.id}:`, err.message);
      }
    }
    if (stars !== q.stars || reactions !== q.reactions || isPinned !== q.pinned) {
      await env.DB.prepare("UPDATE quotes SET stars = ?, reactions = ?, pinned = ? WHERE message_id = ?")
        .bind(stars, reactions, isPinned, q.message_id)
        .run();
    }
  }
  return { added: found.length, pinned };
}

/** Runs from the 5-minute cron: sync up to `limit` quote books. */
export async function syncDueQuoteBooks(env, { limit = 2 } = {}) {
  if (!env.DB) return 0;
  await ensureQuoteTables(env);
  const { results } = await env.DB.prepare("SELECT * FROM quote_books ORDER BY RANDOM() LIMIT ?").bind(limit).all();
  for (const book of results) {
    try {
      await syncQuoteBook(env, book);
    } catch (err) {
      console.error(`Quote Book sync for ${book.guild_id} failed:`, err);
      if (err.status === 404 || err.status === 403) {
        console.warn(`Quote Book channel ${book.channel_id} is gone or unreadable; leaving it for an admin to fix`);
      }
    }
  }
  return results.length;
}

export function siteUrl(env, guildId) {
  const base = (env.PUBLIC_URL || "https://discord-ai-general-bot.asharfarooq.workers.dev").replace(/\/$/, "");
  return `${base}/quotes/${guildId}`;
}

const short = (text, n) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

export function formatQuote(q, timeZone = "America/New_York") {
  const who = q.speaker_id ? `<@${q.speaker_id}>` : q.speaker || "someone";
  const date = new Date(q.posted_at).toLocaleDateString("en-US", { timeZone, month: "short", day: "numeric", year: "numeric" });
  const stars = q.stars ? ` ⭐ ${q.stars}` : "";
  return `💬 "${short(q.text, 400)}" — ${who}, ${date}${stars}\nhttps://discord.com/channels/${q.guild_id}/${q.channel_id}/${q.message_id}`;
}

export async function quotes(interaction, env) {
  const action = getSubcommand(interaction) ?? "random";
  if (!interaction.guild_id) throw new UserFacingError("The Quote Book only works inside a server.");
  await ensureQuoteTables(env);
  const reply = (content) => editOriginal(env, interaction, { content: content.slice(0, 1990), allowed_mentions: NO_MENTIONS });
  const guildId = interaction.guild_id;
  const timeZone = env.TIMEZONE || "America/New_York";

  if ((action === "setup" || action === "off") && !canManageChannels(interaction)) {
    throw new UserFacingError("🔒 Only people who can manage channels can set up or stop the Quote Book.");
  }

  if (action === "setup") {
    const channelId = getOption(interaction, "channel") ?? interaction.channel_id;
    // Everyone in the server can open the website, so the channel must be one everyone can see.
    const [guild, channel] = await Promise.all([
      discordApi(env, `/guilds/${guildId}`),
      discordApi(env, `/channels/${channelId}`),
    ]);
    if (!isPublicChannel(guild, channel)) {
      throw new UserFacingError("🔒 The Quote Book needs a channel everyone in the server can see, since all members can open its website.");
    }
    await env.DB.prepare(
      `INSERT INTO quote_books (guild_id, guild_name, channel_id, last_message_id, created_by) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(guild_id) DO UPDATE SET guild_name = excluded.guild_name, channel_id = excluded.channel_id,
         last_message_id = excluded.last_message_id`,
    )
      .bind(guildId, guild.name ?? null, channelId, null, interaction.member?.user?.id ?? null)
      .run();

    // Import recent history now, then keep up every 5 minutes.
    const history = await fetchHistory(env, channelId, BACKFILL_MESSAGES);
    const { found } = await extractQuotes(env, history);
    await saveQuotes(env, guildId, channelId, found);
    await fixMentionSpeakers(env, guildId);
    await env.DB.prepare("UPDATE quote_books SET last_message_id = ? WHERE guild_id = ?").bind(history.length ? newestId(history) : null, guildId).run();

    await reply(
      `📖 The Quote Book is on for <#${channelId}>. I saved **${found.length}** quote${found.length === 1 ? "" : "s"} from the last ${history.length} messages ` +
        `and will keep adding new ones every few minutes. Quotes with ${STAR_PIN_THRESHOLD}+ ⭐ get pinned.\nBrowse them: ${siteUrl(env, guildId)}`,
    );
    return;
  }

  if (action === "off") {
    await env.DB.prepare("DELETE FROM quote_books WHERE guild_id = ?").bind(guildId).run();
    await reply("📖 Stopped saving new quotes. The saved ones stay; run `/quotes setup` to pick it back up.");
    return;
  }

  if (action === "site") {
    const book = await env.DB.prepare("SELECT * FROM quote_books WHERE guild_id = ?").bind(guildId).first();
    if (!book) throw new UserFacingError("📖 The Quote Book isn't set up yet. Someone who can manage channels can run `/quotes setup`.");
    await reply(`📖 Browse the Quote Book (sign in with Discord): ${siteUrl(env, guildId)}`);
    return;
  }

  if (action === "top") {
    const { results } = await env.DB.prepare(
      "SELECT * FROM quotes WHERE guild_id = ? ORDER BY stars DESC, reactions DESC, posted_at DESC LIMIT 5",
    )
      .bind(guildId)
      .all();
    if (!results.length) throw new UserFacingError("📖 No quotes saved yet.");
    await reply(`🏆 **Top quotes**\n${results.map((r) => formatQuote(r, timeZone)).join("\n")}`);
    return;
  }

  // random [from] [search]
  const from = getOption(interaction, "from")?.trim();
  const search = getOption(interaction, "search")?.trim();
  const where = ["guild_id = ?"];
  const args = [guildId];
  if (from) {
    where.push("(speaker LIKE ? OR poster_name LIKE ?)");
    args.push(`%${from}%`, `%${from}%`);
  }
  if (search) {
    where.push("text LIKE ?");
    args.push(`%${search}%`);
  }
  const q = await env.DB.prepare(`SELECT * FROM quotes WHERE ${where.join(" AND ")} ORDER BY RANDOM() LIMIT 1`)
    .bind(...args)
    .first();
  if (!q) {
    const filters = [from && `from "${from}"`, search && `about "${search}"`].filter(Boolean).join(" ");
    throw new UserFacingError(filters ? `📖 No quotes ${filters} yet.` : "📖 No quotes saved yet.");
  }
  await reply(formatQuote(q, timeZone));
}
