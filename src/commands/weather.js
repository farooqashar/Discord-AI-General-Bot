// /weather: free forecasts from Open-Meteo (no API key, no AI).

import { UserFacingError, getOption, replyWithText } from "../discord.js";

const GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";

const US_STATES = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado",
  CT: "Connecticut", DE: "Delaware", DC: "District of Columbia", FL: "Florida", GA: "Georgia",
  HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky",
  LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota",
  MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire",
  NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota",
  OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island",
  SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont",
  VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};

// WMO weather codes → [label, emoji]
const CONDITIONS = {
  0: ["Clear", "☀️"],
  1: ["Mostly clear", "🌤️"],
  2: ["Partly cloudy", "⛅"],
  3: ["Cloudy", "☁️"],
  45: ["Fog", "🌫️"],
  48: ["Freezing fog", "🌫️"],
  51: ["Light drizzle", "🌦️"],
  53: ["Drizzle", "🌦️"],
  55: ["Heavy drizzle", "🌧️"],
  56: ["Freezing drizzle", "🌧️"],
  57: ["Freezing drizzle", "🌧️"],
  61: ["Light rain", "🌦️"],
  63: ["Rain", "🌧️"],
  65: ["Heavy rain", "🌧️"],
  66: ["Freezing rain", "🌧️"],
  67: ["Freezing rain", "🌧️"],
  71: ["Light snow", "🌨️"],
  73: ["Snow", "🌨️"],
  75: ["Heavy snow", "❄️"],
  77: ["Snow grains", "🌨️"],
  80: ["Showers", "🌦️"],
  81: ["Showers", "🌧️"],
  82: ["Heavy showers", "🌧️"],
  85: ["Snow showers", "🌨️"],
  86: ["Heavy snow showers", "❄️"],
  95: ["Thunderstorms", "⛈️"],
  96: ["Thunderstorms with hail", "⛈️"],
  99: ["Thunderstorms with hail", "⛈️"],
};

export function describe(code, isDay = true) {
  const [label, emoji] = CONDITIONS[code] ?? ["Unknown", "🌡️"];
  return { label, emoji: code === 0 && !isDay ? "🌙" : code === 1 && !isDay ? "🌙" : emoji };
}

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Weather service error (${res.status})`);
  return res.json();
}

/**
 * "Huntington, NY" → the best matching place. The geocoder only matches place
 * names, so we search the first part and use the rest (a US state, region or
 * country) to pick among the results.
 */
export async function findPlace(query) {
  const [namePart, ...rest] = query.split(",").map((s) => s.trim()).filter(Boolean);
  if (!namePart) return null;
  const qualifier = rest.join(", ").toLowerCase();
  const stateName = US_STATES[qualifier.toUpperCase()]?.toLowerCase();

  const params = new URLSearchParams({ name: namePart, count: "10", language: "en", format: "json" });
  const data = await getJson(`${GEOCODE_URL}?${params}`);
  const results = data.results ?? [];
  if (!results.length) return null;

  const matches = qualifier
    ? results.filter((r) => {
        const fields = [r.admin1, r.admin2, r.country, r.country_code].filter(Boolean).map((f) => f.toLowerCase());
        return fields.some((f) => f === qualifier || f === stateName || f.includes(qualifier));
      })
    : results;
  const pool = matches.length ? matches : results;
  // Prefer the biggest place with that name, e.g. New York City over a small town.
  return [...pool].sort((a, b) => (b.population ?? 0) - (a.population ?? 0))[0];
}

export function placeLabel(place) {
  const region = place.country_code === "US" ? place.admin1 : place.country;
  return region && region !== place.name ? `${place.name}, ${region}` : place.name;
}

export function formatWeather(place, forecast) {
  const c = forecast.current;
  const d = forecast.daily;
  const now = describe(c.weather_code, c.is_day !== 0);
  const round = (n) => Math.round(n);

  const lines = [
    `${now.emoji} **${placeLabel(place)}**: ${round(c.temperature_2m)}°F (feels ${round(c.apparent_temperature)}°F), ${now.label}`,
    `💨 ${round(c.wind_speed_10m)} mph · 💧 ${round(c.relative_humidity_2m)}% humidity`,
  ];

  if (d?.time?.length) {
    const rain = (i) => (d.precipitation_probability_max?.[i] != null ? ` · ${d.precipitation_probability_max[i]}% rain` : "");
    lines.push(`**Today:** ↑${round(d.temperature_2m_max[0])}° ↓${round(d.temperature_2m_min[0])}°${rain(0)}`);
    const days = [];
    for (let i = 1; i < d.time.length; i++) {
      // Dates are local to the place; read them as plain calendar dates.
      const weekday = new Date(`${d.time[i]}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
      days.push(`${weekday} ${describe(d.weather_code[i]).emoji} ${round(d.temperature_2m_max[i])}°/${round(d.temperature_2m_min[i])}°${rain(i).replace(" · ", " ")}`);
    }
    if (days.length) lines.push(days.join(" · "));
  }
  return lines.join("\n");
}

export async function weather(interaction, env) {
  const query = getOption(interaction, "place") || env.DEFAULT_AREA || "New York, NY";

  const place = await findPlace(query);
  if (!place) throw new UserFacingError(`🤔 I couldn't find a place called "${query}". Try a city name, like "Boston" or "Huntington, NY".`);

  const params = new URLSearchParams({
    latitude: String(place.latitude),
    longitude: String(place.longitude),
    current: "temperature_2m,apparent_temperature,weather_code,wind_speed_10m,relative_humidity_2m,is_day",
    daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
    temperature_unit: "fahrenheit",
    wind_speed_unit: "mph",
    timezone: "auto",
    forecast_days: "4",
  });
  const forecast = await getJson(`${FORECAST_URL}?${params}`);
  await replyWithText(env, interaction, formatWeather(place, forecast));
}
