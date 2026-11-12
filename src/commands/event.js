import { describeNow, extractStructured } from "../claude.js";
import { discordApi, discordTimestamp, getOption, replyWithText } from "../discord.js";

const SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string", description: "Short, friendly event title (max 100 characters)" },
    start_time: {
      type: "string",
      description: "Start as ISO 8601 with the UTC offset, e.g. 2026-11-14T20:00:00-05:00",
    },
    end_time: {
      type: ["string", "null"],
      description: "End as ISO 8601 with offset, or null if not mentioned",
    },
    location: { type: ["string", "null"], description: "Where it happens, or null if not mentioned" },
    description: {
      type: ["string", "null"],
      description: "One or two friendly sentences describing the event, or null",
    },
    missing_info: {
      type: ["string", "null"],
      description: "If no usable date or time was given, say what's missing. Otherwise null.",
    },
  },
  required: ["name", "start_time", "end_time", "location", "description", "missing_info"],
};

const TWO_HOURS = 2 * 60 * 60 * 1000;

export async function event(interaction, env) {
  const details = getOption(interaction, "details");
  if (!interaction.guild_id) {
    await replyWithText(env, interaction, "Events can only be created inside a server.");
    return;
  }

  const timeZone = env.TIMEZONE || "America/New_York";
  const parsed = await extractStructured(env, {
    system: `You turn casual descriptions of plans into calendar events. ${describeNow(timeZone)}
Interpret times in ${timeZone} unless another zone is stated. Relative days like "Saturday" mean the next upcoming one.`,
    prompt: details,
    toolName: "create_event",
    description: "Create a Discord scheduled event",
    schema: SCHEMA,
  });

  if (parsed.missing_info) {
    await replyWithText(env, interaction, `🤔 I couldn't create that event: ${parsed.missing_info}`);
    return;
  }

  const start = new Date(parsed.start_time);
  if (Number.isNaN(start.getTime())) throw new Error(`Couldn't understand the start time "${parsed.start_time}"`);
  if (start.getTime() < Date.now()) {
    await replyWithText(env, interaction, `🤔 That time (${discordTimestamp(start)}) is already in the past.`);
    return;
  }
  let end = parsed.end_time ? new Date(parsed.end_time) : null;
  if (!end || Number.isNaN(end.getTime()) || end <= start) end = new Date(start.getTime() + TWO_HOURS);

  const location = (parsed.location || "TBD").slice(0, 100);
  const created = await discordApi(env, `/guilds/${interaction.guild_id}/scheduled-events`, {
    method: "POST",
    body: {
      name: parsed.name.slice(0, 100),
      description: parsed.description?.slice(0, 1000) || undefined,
      scheduled_start_time: start.toISOString(),
      scheduled_end_time: end.toISOString(),
      privacy_level: 2, // guild only
      entity_type: 3, // external: happens outside a Discord voice channel
      entity_metadata: { location },
    },
  });

  await replyWithText(
    env,
    interaction,
    `📅 Created **${created.name}**\n` +
      `🕒 ${discordTimestamp(start)} (${discordTimestamp(start, "R")})\n` +
      `📍 ${location}\n` +
      `https://discord.com/events/${interaction.guild_id}/${created.id}`,
  );
}
