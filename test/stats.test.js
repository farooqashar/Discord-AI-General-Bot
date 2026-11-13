import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { computeStats, formatStats, stats } from "../src/commands/stats.js";
import { fetchHistory } from "../src/discord.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const m = (id, name, content, iso, extra = {}) => ({
  id,
  content,
  timestamp: iso,
  author: { id: name, username: name },
  ...extra,
});

const SAMPLE = [
  m("1", "ashar", "ramen tonight? 🍜🍜 https://maps.example/x", "2026-11-13T23:10:00Z"), // Fri 6 PM ET
  m("2", "sunny", "ramen again lol <:pepe:123>", "2026-11-13T23:20:00Z", {
    reactions: [{ count: 4, emoji: { name: "😂" } }],
  }),
  m("3", "ashar", "the LIRR is late again 😭", "2026-11-12T12:00:00Z", { attachments: [{}] }),
  m("4", "javier", "ramen is mid", "2026-11-13T23:40:00Z"),
];

test("counts people, words, emoji, links, files and the most reacted message", () => {
  const s = computeStats(SAMPLE, "America/New_York");
  assert.equal(s.total, 4);
  assert.equal(s.peopleCount, 3);
  assert.deepEqual(s.people[0], ["ashar", 2]);
  assert.deepEqual(s.words[0], ["ramen", 3]);
  for (const filler of ["the", "lol", "again", "https", "tonight?"]) {
    assert.ok(!s.words.some(([w]) => w === filler), `"${filler}" isn't counted`);
  }
  assert.deepEqual(s.emoji[0], ["😂", 4], "reactions count toward emoji");
  assert.ok(s.emoji.some(([e, n]) => e === "🍜" && n === 2));
  assert.ok(s.emoji.some(([e]) => e === "<:pepe:123>"));
  assert.equal(s.links, 1);
  assert.equal(s.files, 1);
  assert.equal(s.busiestDay, "Friday");
  assert.equal(s.busiestHour, 18);
  assert.equal(s.mostReacted.message.id, "2");
});

test("formats a readable summary", () => {
  const text = formatStats(computeStats(SAMPLE, "America/New_York"), {
    where: "this channel",
    days: 7,
    guildId: "g",
    channelId: "c",
  });
  assert.match(text, /^📊 \*\*Stats for this channel\*\* · last 7 days/);
  assert.match(text, /\*\*4\*\* messages from \*\*3\*\* people · ~1\/day · 🔗 1 link · 📎 1 file$/m);
  assert.match(text, /`▰▰▰▰▰▰▰▰` ashar · 2/);
  assert.match(text, /\*\*Busiest:\*\* Fridays around 6 PM/);
  assert.match(text, /\*\*Most reacted:\*\* "ramen again lol <:pepe:123>" \(sunny, 4 reactions\) https:\/\/discord\.com\/channels\/g\/c\/2/);
});

test("fetchHistory stops at messages older than the cutoff", async () => {
  const day = (d) => `2026-11-${String(d).padStart(2, "0")}T12:00:00Z`;
  const page1 = Array.from({ length: 100 }, (_, i) => m(String(1000 - i), "a", "x", day(13)));
  const page2 = [m("899", "a", "x", day(12)), m("898", "a", "x", day(1))];
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls++;
    return Response.json(String(url).includes("before=") ? page2 : page1);
  };
  const out = await fetchHistory({}, "c", 1000, { since: new Date(day(10)) });
  assert.equal(out.length, 101);
  assert.equal(calls, 2, "no more pages after reaching old messages");
});

test("/stats skips bots and reads only the requested days", async () => {
  const now = Date.now();
  const iso = (hoursAgo) => new Date(now - hoursAgo * 3600000).toISOString();
  const edits = [];
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).includes("/channels/c1/messages")) {
      return Response.json([
        m("3", "ashar", "hi", iso(1)),
        m("2", "bot", "beep", iso(2), { author: { id: "bot", bot: true } }),
        m("1", "sunny", "old", iso(24 * 3)),
      ]);
    }
    edits.push(JSON.parse(init.body));
    return Response.json({ id: "1" });
  };
  await stats(
    { application_id: "app", token: "t", channel_id: "c1", guild_id: "g", data: { options: [{ name: "days", value: 2 }] } },
    {},
  );
  assert.match(edits[0].content, /\*\*1\*\* messages from \*\*1\*\* person/);
  assert.match(edits[0].content, /last 2 days/);
});
