import { extractStructured } from "../claude.js";
import { NO_MENTIONS, editOriginal, fetchHistory, getOption, targetChannel } from "../discord.js";

const SCHEMA = {
  type: "object",
  properties: {
    headline: { type: "string", description: "A short, funny one-line description of the channel's vibe" },
    emoji: { type: "string", description: "One emoji that captures the vibe" },
    energy: { type: "integer", minimum: 1, maximum: 5, description: "1 = sleepy, 5 = chaotic" },
    silliness: { type: "integer", minimum: 1, maximum: 5, description: "1 = all business, 5 = pure nonsense" },
    positivity: { type: "integer", minimum: 1, maximum: 5, description: "1 = grumpy, 5 = wholesome" },
    topics: {
      type: "array",
      items: { type: "string" },
      maxItems: 5,
      description: "The main things people talk about, a few words each",
    },
    running_jokes: {
      type: "array",
      items: { type: "string" },
      maxItems: 3,
      description: "Recurring bits, inside jokes or catchphrases, if any (a few words each)",
    },
    verdict: { type: "string", description: "One or two playful sentences summing up the channel's personality" },
  },
  required: ["headline", "emoji", "energy", "silliness", "positivity", "topics", "running_jokes", "verdict"],
};

const SYSTEM = `You do a playful "vibe check" of a Discord channel from its message history.
Describe the mood, energy and personality of the conversation, not a play-by-play.
Keep it fun and kind: tease the group lightly, but never single anyone out negatively,
and don't mention anything that seems private or sensitive.`;

const meter = (n, left, right) => `${left} ${"●".repeat(n)}${"○".repeat(5 - n)} ${right}`;
const clamp = (n) => Math.min(5, Math.max(1, Math.round(n) || 3));

function displayName(m) {
  return m.member?.nick ?? m.author.global_name ?? m.author.username;
}

/** Real numbers computed from the messages, so they're exact, not guessed. */
export function channelStats(messages, timeZone) {
  const counts = new Map();
  const hours = new Array(24).fill(0);
  const hourFmt = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23" });
  for (const m of messages) {
    const name = displayName(m);
    counts.set(name, (counts.get(name) ?? 0) + 1);
    hours[Number(hourFmt.format(new Date(m.timestamp))) % 24]++;
  }
  const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 3);
  const busiest = hours.indexOf(Math.max(...hours));
  const times = messages.map((m) => new Date(m.timestamp).getTime());
  return {
    total: messages.length,
    people: counts.size,
    top,
    busiestHour: busiest,
    from: new Date(Math.min(...times)),
    to: new Date(Math.max(...times)),
  };
}

function hourLabel(h) {
  const suffix = h < 12 ? "AM" : "PM";
  return `${h % 12 === 0 ? 12 : h % 12} ${suffix}`;
}

export async function vibeCheck(interaction, env) {
  const channelId = targetChannel(interaction, "vibe-check");
  const count = getOption(interaction, "messages") ?? 200;
  const timeZone = env.TIMEZONE || "America/New_York";

  const history = await fetchHistory(env, channelId, count);
  const messages = history.filter((m) => !m.author?.bot && m.content?.trim()).reverse();
  if (messages.length < 2) {
    await editOriginal(env, interaction, {
      content: "🤷 Not enough conversation there yet to read the vibe.",
      allowed_mentions: NO_MENTIONS,
    });
    return;
  }

  const transcript = messages.map((m) => `${displayName(m)}: ${m.content.slice(0, 300)}`).join("\n");
  const vibe = await extractStructured(env, {
    system: SYSTEM,
    prompt: `Vibe-check this channel (${messages.length} messages, oldest first):\n\n${transcript}`,
    toolName: "vibe_check",
    description: "Report the channel's vibe",
    schema: SCHEMA,
  });

  const stats = channelStats(messages, timeZone);
  const where = channelId === interaction.channel_id ? "this channel" : `<#${channelId}>`;
  const days = Math.max(1, Math.round((stats.to - stats.from) / 86400000));
  const topPosters = stats.top.map(([name, n]) => `${name} (${n})`).join(", ");

  const lines = [
    `${vibe.emoji} **Vibe check: ${where}**`,
    `*${vibe.headline}*`,
    "",
    "```",
    meter(clamp(vibe.energy), "sleepy  ", "chaotic"),
    meter(clamp(vibe.silliness), "serious ", "silly"),
    meter(clamp(vibe.positivity), "grumpy  ", "wholesome"),
    "```",
    `**Talking about:** ${vibe.topics.join(" · ") || "a bit of everything"}`,
  ];
  if (vibe.running_jokes.length) lines.push(`**Running bits:** ${vibe.running_jokes.join(" · ")}`);
  lines.push(
    `**Most active:** ${topPosters}`,
    `**Peak hour:** ${hourLabel(stats.busiestHour)} · ${stats.total} messages from ${stats.people} ${stats.people === 1 ? "person" : "people"} over ~${days} day${days === 1 ? "" : "s"}`,
    "",
    vibe.verdict,
  );

  await editOriginal(env, interaction, {
    content: lines.join("\n").slice(0, 1990),
    allowed_mentions: NO_MENTIONS,
  });
}
