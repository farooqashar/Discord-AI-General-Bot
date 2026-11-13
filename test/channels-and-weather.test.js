import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { ask, formatContext } from "../src/commands/ask.js";
import { tldr } from "../src/commands/tldr.js";
import { findPlace, formatWeather, weather } from "../src/commands/weather.js";
import { targetChannel } from "../src/discord.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const READ = String((1n << 10n) | (1n << 16n)); // View Channel + Read Message History

const interaction = (name, options = [], extra = {}) => ({
  application_id: "bot",
  token: "tok",
  channel_id: "bot-channel",
  member: { user: { id: "u1", username: "ashar" }, nick: "Ashar" },
  data: { name, options, ...extra },
});

function mock(handlers) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    url = String(url);
    calls.push({ url, body: init.body ? JSON.parse(init.body) : undefined });
    for (const [match, respond] of handlers) {
      if (url.includes(match)) return Response.json(respond(url, init));
    }
    return Response.json({ id: "1" });
  };
  return calls;
}
const lastEdit = (calls) => calls.filter((c) => c.url.endsWith("/messages/@original")).at(-1);

test("targetChannel defaults to the current channel and checks access to others", () => {
  assert.equal(targetChannel(interaction("x")), "bot-channel");
  const ok = interaction("x", [{ name: "channel", value: "general" }], {
    resolved: { channels: { general: { permissions: READ } } },
  });
  assert.equal(targetChannel(ok), "general");
  const denied = interaction("x", [{ name: "channel", value: "secret" }], {
    resolved: { channels: { secret: { permissions: String(1n << 10n) } } }, // can view, can't read history
  });
  assert.throws(() => targetChannel(denied, "summarize"), /only summarize channels you can read/);
});

test("/tldr summarizes another channel and says which", async () => {
  let prompt;
  const calls = mock([
    ["anthropic", (_u, init) => {
      prompt = JSON.parse(init.body).messages[0].content;
      return { content: [{ type: "text", text: "They planned dinner." }] };
    }],
    ["/channels/general/messages", () => [
      { content: "tacos?", timestamp: "2026-11-13T14:00:00Z", author: { username: "sam" } },
    ]],
  ]);
  await tldr(
    interaction("tldr", [{ name: "channel", value: "general" }], {
      resolved: { channels: { general: { permissions: READ } } },
    }),
    {},
  );
  assert.match(prompt, /sam: tacos\?/);
  assert.match(lastEdit(calls).body.content, /^📝 \*\*TL;DR\*\* in <#general> \(1 messages\)/);
});

test("formatContext orders messages oldest first and marks the bot's own replies", () => {
  const text = formatContext(
    [
      { author: { id: "bot" }, content: "> where to eat?\\n\\nTry Joe's.", interaction_metadata: { user: { username: "sunny" } } },
      { author: { id: "u2", username: "sunny" }, content: "where to eat?" },
      { author: { id: "u3", username: "ghost" }, content: "" },
    ],
    "bot",
  );
  const lines = text.split("\n");
  assert.equal(lines[0], "sunny: where to eat?");
  assert.match(lines[1], /^you \(replying to sunny\): /);
  assert.equal(lines.length, 2, "empty messages are skipped");
});

test("/ask includes recent chat so follow-ups work", async () => {
  let prompt;
  const calls = mock([
    ["anthropic", (_u, init) => {
      prompt = JSON.parse(init.body).messages[0].content;
      return { content: [{ type: "text", text: "I meant Joe's Shanghai." }] };
    }],
    ["/channels/bot-channel/messages?limit=20", () => [
      { author: { id: "bot" }, content: "Try Joe's." },
      { author: { id: "u2", username: "sunny" }, content: "where should we eat" },
    ]],
  ]);
  await ask(interaction("ask", [{ name: "question", value: "wdym?" }]), {});
  assert.match(prompt, /Recent messages in this channel:\nsunny: where should we eat\nyou: Try Joe's\./);
  assert.match(prompt, /Question from Ashar: wdym\?/);
  assert.match(lastEdit(calls).body.content, /^> wdym\?\n\nI meant Joe's Shanghai\./);
});

test("/ask still answers if it can't read the channel", async () => {
  let prompt;
  const calls = mock([
    ["anthropic", (_u, init) => {
      prompt = JSON.parse(init.body).messages[0].content;
      return { content: [{ type: "text", text: "Paris." }] };
    }],
  ]);
  globalThis.fetch = ((inner) => async (url, init) =>
    String(url).includes("/channels/") ? new Response("{}", { status: 403 }) : inner(url, init))(globalThis.fetch);
  const warn = console.warn;
  console.warn = () => {};
  try {
    await ask(interaction("ask", [{ name: "question", value: "capital of France?" }]), {});
  } finally {
    console.warn = warn;
  }
  assert.equal(prompt, "Question from Ashar: capital of France?");
  assert.match(lastEdit(calls).body.content, /Paris\./);
});

const GEO = {
  results: [
    { name: "Huntington", admin1: "West Virginia", country: "United States", country_code: "US", latitude: 38.4, longitude: -82.4, population: 46000 },
    { name: "Huntington", admin1: "New York", country: "United States", country_code: "US", latitude: 40.87, longitude: -73.43, population: 18000 },
    { name: "Huntington", admin1: "England", country: "United Kingdom", country_code: "GB", latitude: 54.0, longitude: -1.0, population: 3000 },
  ],
};

test("findPlace uses the state or country to pick the right town", async () => {
  mock([["geocoding-api", () => GEO]]);
  assert.equal((await findPlace("Huntington, NY")).admin1, "New York");
  assert.equal((await findPlace("Huntington, England")).country_code, "GB");
  assert.equal((await findPlace("Huntington")).admin1, "West Virginia", "biggest wins with no qualifier");
});

const FORECAST = {
  current: { temperature_2m: 51.6, apparent_temperature: 47.2, weather_code: 2, wind_speed_10m: 9.4, relative_humidity_2m: 61, is_day: 1 },
  daily: {
    time: ["2026-11-13", "2026-11-14", "2026-11-15", "2026-11-16"],
    weather_code: [2, 0, 61, 3],
    temperature_2m_max: [55.1, 58, 50, 53],
    temperature_2m_min: [44, 45, 41, 40],
    precipitation_probability_max: [10, 0, 70, 20],
  },
};

test("formats current weather and the next three days", () => {
  const text = formatWeather(GEO.results[1], FORECAST);
  assert.match(text, /^⛅ \*\*Huntington, New York\*\*: 52°F \(feels 47°F\), Partly cloudy/);
  assert.match(text, /💨 9 mph · 💧 61% humidity/);
  assert.match(text, /\*\*Today:\*\* ↑55° ↓44° · 10% rain/);
  assert.match(text, /Sat ☀️ 58°\/45° 0% rain · Sun 🌦️ 50°\/41° 70% rain · Mon ☁️ 53°\/40° 20% rain/);
});

test("/weather asks Open-Meteo in Fahrenheit and defaults to New York", async () => {
  const calls = mock([
    ["geocoding-api", () => ({ results: [{ name: "New York", admin1: "New York", country_code: "US", latitude: 40.71, longitude: -74.01, population: 8800000 }] })],
    ["api.open-meteo.com", () => FORECAST],
  ]);
  await weather(interaction("weather"), { DEFAULT_AREA: "New York, NY" });
  const geo = calls.find((c) => c.url.includes("geocoding-api"));
  assert.match(geo.url, /name=New\+York/);
  const fc = new URL(calls.find((c) => c.url.startsWith("https://api.open-meteo.com")).url);
  assert.equal(fc.searchParams.get("temperature_unit"), "fahrenheit");
  assert.equal(fc.searchParams.get("timezone"), "auto");
  assert.match(lastEdit(calls).body.content, /\*\*New York\*\*: 52°F/);
});

test("/weather explains when a place can't be found", async () => {
  mock([["geocoding-api", () => ({})]]);
  await assert.rejects(weather(interaction("weather", [{ name: "place", value: "Atlantis" }]), {}), /couldn't find a place called "Atlantis"/);
});
