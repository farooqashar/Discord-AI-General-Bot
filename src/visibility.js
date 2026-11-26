// Which saved settings can be listed in a channel without leaking a private one.

import { discordApi } from "./discord.js";
import { isPublicChannel } from "./commands/stats.js";

const THREAD_TYPES = new Set([10, 11, 12]);
const PRIVATE_THREAD = 12;

/**
 * Split `rows` (each with a `channel_id`) into the ones that can be shown in
 * `channelId`: its own, plus ones for channels everyone in the server can
 * read. Threads follow their parent, private threads are private, and a
 * channel that's gone or can't be read counts as private. If Discord can't be
 * reached, only this channel's rows are shown.
 */
export async function visibleRows(env, guildId, channelId, rows) {
  const split = (publicIds) => {
    const shown = rows.filter((r) => publicIds.has(r.channel_id));
    return { shown, hidden: rows.length - shown.length };
  };
  const publicIds = new Set([channelId]);
  if (!guildId || rows.every((r) => r.channel_id === channelId)) return split(publicIds);
  let guild;
  let channels;
  try {
    [guild, channels] = await Promise.all([
      discordApi(env, `/guilds/${guildId}`),
      discordApi(env, `/guilds/${guildId}/channels`),
    ]);
  } catch (err) {
    console.warn("Couldn't check which channels are public; showing only this channel's settings:", err.message);
    return split(publicIds);
  }
  const byId = new Map(channels.map((c) => [c.id, c]));
  for (const id of new Set(rows.map((r) => r.channel_id))) {
    if (publicIds.has(id)) continue;
    // The channel list leaves out threads, so look those up one by one.
    const channel = byId.get(id) ?? (await discordApi(env, `/channels/${id}`).catch(() => null));
    if (!channel || channel.type === PRIVATE_THREAD) continue;
    const source = THREAD_TYPES.has(channel.type) ? byId.get(channel.parent_id) : channel;
    if (source && isPublicChannel(guild, source)) publicIds.add(id);
  }
  return split(publicIds);
}

/** "1 more digest is set up in a channel not everyone can see." */
export function hiddenNote(hidden, noun) {
  if (!hidden) return "";
  return hidden === 1
    ? `\n_1 more ${noun} is set up in a channel not everyone can see._`
    : `\n_${hidden} more ${noun}s are set up in channels not everyone can see._`;
}
