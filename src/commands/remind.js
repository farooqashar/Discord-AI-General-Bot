import { describeNow, extractStructured } from "../claude.js";
import {
  UserFacingError,
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
  if (Number.isNaN(due.getTime())) throw new UserFacingError("I couldn't figure out when that is. Try something like \"tomorrow at 6pm\".");
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

// A reminder that keeps failing for a transient reason is retried every
// minute until it is this late, then dropped.
const GIVE_UP_AFTER = 60 * 60;

/**
 * Runs every minute (cron trigger): posts any reminders that are due.
 * Due reminders are taken oldest row first, and a retried one goes back in
 * as a new row, so reminders that keep failing move to the back of the
 * queue instead of filling every run's batch of 25.
 */
export async function postDueReminders(env) {
  const now = Math.floor(Date.now() / 1000);
  const { results } = await env.DB.prepare(
    "SELECT id, channel_id, user_id, message, due_at, created_at FROM reminders WHERE due_at <= ? ORDER BY id LIMIT 25",
  )
    .bind(now)
    .all();

  for (const reminder of results) {
    // Claim it first so an overlapping run can't post it twice.
    const claimed = await env.DB.prepare("DELETE FROM reminders WHERE id = ?").bind(reminder.id).run();
    if (claimed.meta?.changes === 0) continue;

    try {
      await sendChannelMessage(env, reminder.channel_id, {
        content: `⏰ **Reminder** from <@${reminder.user_id}>: ${reminder.message}`,
        allowed_mentions: { users: [reminder.user_id] },
      });
    } catch (err) {
      // A 4xx (deleted channel, missing permission) won't change on retry.
      // Anything else (5xx, network, rate limits) gets another go next minute.
      const permanent = err.status >= 400 && err.status < 500;
      const tooLate = now - reminder.due_at > GIVE_UP_AFTER;
      if (permanent || tooLate) {
        console.error(`Reminder ${reminder.id} could not be posted, dropping it:`, err.message);
        continue;
      }
      console.warn(`Reminder ${reminder.id} could not be posted, will retry:`, err.message);
      await env.DB.prepare(
        "INSERT INTO reminders (channel_id, user_id, message, due_at, created_at) VALUES (?, ?, ?, ?, ?)",
      )
        .bind(reminder.channel_id, reminder.user_id, reminder.message, reminder.due_at, reminder.created_at)
        .run();
    }
  }
}
