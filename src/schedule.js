// Helpers for posts that run on a schedule (/digest, /wrapped).

import { UserFacingError } from "./discord.js";

/** "8am", "8:30 pm", "18:00" → { hour, minute }. */
export function parseTime(text) {
  const m = String(text ?? "").trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) throw new UserFacingError(`🤔 I couldn't read "${text}" as a time. Try "8am", "6:30pm" or "18:00".`);
  let hour = Number(m[1]);
  const minute = Number(m[2] ?? 0);
  if (m[3]) {
    if (hour < 1 || hour > 12) throw new UserFacingError(`🤔 "${text}" isn't a valid time.`);
    hour = (hour % 12) + (m[3] === "pm" ? 12 : 0);
  }
  if (hour > 23 || minute > 59) throw new UserFacingError(`🤔 "${text}" isn't a valid time.`);
  return { hour, minute };
}

export function formatTime({ hour, minute }) {
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return `${h}${minute ? `:${String(minute).padStart(2, "0")}` : ""}${hour < 12 ? "am" : "pm"}`;
}

export const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/** The date, weekday and time right now in a time zone. */
export function localNow(timeZone, now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "long",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    day: Number(parts.day),
    weekday: WEEKDAYS.indexOf(parts.weekday.toLowerCase()),
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

/**
 * Is a post scheduled for `hour:minute` (on `weekday`, or the 1st of the month
 * when monthly) due now, and not already sent today?
 */
export function isDue(schedule, now) {
  if (schedule.last_sent === now.date) return false;
  if (schedule.frequency === "weekly" && now.weekday !== schedule.weekday) return false;
  if (schedule.frequency === "monthly" && now.day !== 1) return false;
  return now.minutes >= schedule.hour * 60 + schedule.minute;
}

/**
 * When setting up a schedule whose time already passed today, mark today as
 * sent so it doesn't fire the moment it's created.
 */
export function initialLastSent(schedule, now) {
  return isDue({ ...schedule, last_sent: null }, now) ? now.date : null;
}
