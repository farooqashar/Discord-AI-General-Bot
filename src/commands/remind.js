import { describeNow, extractStructured } from "../claude.js";
import {
  discordTimestamp,
  getOption,
  invokingUser,
  replyWithText,
  sendChannelMessage,
} from "../discord.js";

const SCHEMA = {
  type: "object",
  properties: {
    remind_at: {
      type: "string",
      description: "When to post the reminder, as ISO 8601 with the UTC offset",
    },
    message: {
      type: "string",
      description: 'What to remind about, short and in plain words, e.g. "book the restaurant"',
    },
    missing_info: {
      type: ["string", "null"],
      description: "If no usable time was given, say what's missing. Otherwise null.",
    },
  },
  required: ["remind_at", "message", "missing_info"],
};

const ONE_YEAR = 365 * 24 * 60 * 60 * 1000;

export async function remind(interaction, env) {
  const request = getOption(interaction, "reminder");
  const timeZone = env.TIMEZONE || "America/New_York";

  const parsed = await extractStructured(env, {
    system: `You turn casual reminder requests into a time and a message. ${describeNow(timeZone)}
Interpret times in ${timeZone} unless another zone is stated. "In 2 hours" is relative to now.
If only a day is given with no time, use 9:00 AM.`,
    prompt: request,
    toolName: "set_reminder",
    description: "Schedule a reminder to post in this Discord channel",
    schema: SCHEMA,
  });

  if (parsed.missing_info) {
    await replyWithText(env, interaction, `🤔 I couldn't set that reminder: ${parsed.missing_info}`);
    return;
  }

  const due = new Date(parsed.remind_at);
  if (Number.isNaN(due.getTime())) throw new Error(`Couldn't understand the time "${parsed.remind_at}"`);
  if (due.getTime() < Date.now()) {
    await replyWithText(env, interaction, `🤔 That time (${discordTimestamp(due)}) is already in the past.`);
    return;
  }
  if (due.getTime() - Date.now() > ONE_YEAR) {
    await replyWithText(env, interaction, "🤔 I can only set reminders up to a year ahead.");
    return;
  }

  const user = invokingUser(interaction);
  const message = parsed.message.slice(0, 500);
  await env.DB.prepare(
    "INSERT INTO reminders (channel_id, user_id, message, due_at) VALUES (?, ?, ?, ?)",
  )
    .bind(interaction.channel_id, user.id, message, Math.floor(due.getTime() / 1000))
    .run();

  await replyWithText(
    env,
    interaction,
    `⏰ Got it! I'll post a reminder here ${discordTimestamp(due)} (${discordTimestamp(due, "R")}):\n> ${message}`,
  );
}

/** Runs every minute (cron trigger): posts any reminders that are due. */
export async function postDueReminders(env) {
  const now = Math.floor(Date.now() / 1000);
  const { results } = await env.DB.prepare(
    "SELECT id, channel_id, user_id, message FROM reminders WHERE due_at <= ? ORDER BY due_at LIMIT 25",
  )
    .bind(now)
    .all();

  for (const reminder of results) {
    try {
      await sendChannelMessage(env, reminder.channel_id, {
        content: `⏰ **Reminder** from <@${reminder.user_id}>: ${reminder.message}`,
        allowed_mentions: { users: [reminder.user_id] },
      });
    } catch (err) {
      // Usually a deleted channel or missing permission; retrying won't help.
      console.error(`Reminder ${reminder.id} could not be posted:`, err.message);
    }
    await env.DB.prepare("DELETE FROM reminders WHERE id = ?").bind(reminder.id).run();
  }
}
