import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { COMMANDS } from "../src/command-definitions.js";
import { decide, parseOptions } from "../src/commands/decide.js";
import { event, googleCalendarUrl } from "../src/commands/event.js";
import { roast } from "../src/commands/roast.js";
import { trivia } from "../src/commands/trivia.js";
import { HANDLERS } from "../src/index.js";
import { syncCommandsIfChanged } from "../src/register.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Fake fetch: Claude returns `claude(body)`, Discord calls are recorded. */
function mockFetch({ claude, discord = () => ({ id: "1" }) }) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    url = String(url);
    const isForm = init.body instanceof FormData;
    const body = init.body && !isForm ? JSON.parse(init.body) : init.body;
    calls.push({ url, method: init.method ?? "GET", body });
    if (url.includes("anthropic")) return Response.json(claude(body));
    return Response.json(discord(url, init));
  };
  return calls;
}

const interaction = (name, options = [], extra = {}) => ({
  application_id: "app",
  token: "tok",
  channel_id: "chan",
  guild_id: "guild",
  member: { user: { id: "me" } },
  data: { name, options, ...extra },
});

const lastEdit = (calls) =>
  calls.filter((c) => c.url.endsWith("/messages/@original")).at(-1);

test("every registered command has a handler and vice versa", () => {
  const names = COMMANDS.map((c) => c.name).sort();
  assert.deepEqual(names, Object.keys(HANDLERS).sort());
  for (const c of COMMANDS) {
    assert.ok(c.description.length <= 100, `/${c.name} description too long`);
    assert.deepEqual(c.contexts, [0]);
  }
});

test("parses /decide options in common formats", () => {
  assert.deepEqual(parseOptions("pizza, sushi, tacos"), ["pizza", "sushi", "tacos"]);
  assert.deepEqual(parseOptions("pizza or sushi or tacos"), ["pizza", "sushi", "tacos"]);
  assert.deepEqual(parseOptions("pizza, sushi, or tacos"), ["pizza", "sushi", "tacos"]);
  assert.deepEqual(parseOptions("just pizza"), ["just pizza"]);
});

test("/decide picks one of the options and refuses a single option", async () => {
  const calls = mockFetch({ claude: () => ({ content: [{ type: "text", text: "It was destiny." }] }) });
  await decide(interaction("decide", [{ name: "options", value: "pizza, sushi" }]), {});
  const content = lastEdit(calls).body.content;
  assert.match(content, /👉 \*\*(pizza|sushi)\*\*/);
  assert.match(content, /destiny/);

  const calls2 = mockFetch({ claude: () => assert.fail("shouldn't call Claude") });
  await decide(interaction("decide", [{ name: "options", value: "pizza" }]), {});
  assert.match(lastEdit(calls2).body.content, /at least two options/);
});

test("builds a valid Google Calendar link that fits in a Discord button", () => {
  const start = new Date("2026-11-14T01:00:00Z");
  const end = new Date("2026-11-14T03:00:00Z");
  const url = new URL(
    googleCalendarUrl({ name: "Board games", start, end, location: "Ashar's place", details: "Bring snacks" }),
  );
  assert.equal(url.hostname, "calendar.google.com");
  assert.equal(url.searchParams.get("action"), "TEMPLATE");
  assert.equal(url.searchParams.get("text"), "Board games");
  assert.equal(url.searchParams.get("dates"), "20261114T010000Z/20261114T030000Z");
  assert.equal(url.searchParams.get("location"), "Ashar's place");

  const long = googleCalendarUrl({ name: "X", start, end, location: "Y", details: "word ".repeat(300) });
  assert.ok(long.length <= 512);
});

test("/event creates the Discord event and shows the Google Calendar button", async () => {
  const start = new Date(Date.now() + 3 * 86400000);
  const calls = mockFetch({
    claude: () => ({
      content: [
        {
          type: "tool_use",
          name: "create_event",
          input: {
            name: "Board game night",
            start_time: start.toISOString(),
            end_time: null,
            location: "Ashar's place",
            description: "Bring snacks",
            missing_info: null,
          },
        },
      ],
    }),
    discord: (url) => (url.includes("scheduled-events") ? { id: "ev1", name: "Board game night" } : { id: "m" }),
  });

  await event(interaction("event", [{ name: "details", value: "board games saturday 8pm" }]), {});

  const created = calls.find((c) => c.url.includes("/guilds/guild/scheduled-events"));
  assert.equal(created.body.entity_metadata.location, "Ashar's place");
  const edit = lastEdit(calls).body;
  const buttons = edit.components[0].components;
  assert.equal(buttons[0].label, "Add to Google Calendar");
  assert.match(buttons[0].url, /^https:\/\/calendar\.google\.com\/calendar\/render\?action=TEMPLATE/);
  assert.equal(buttons[1].url, "https://discord.com/events/guild/ev1");
});

test("/trivia hides the answer in a spoiler and includes all four choices", async () => {
  const calls = mockFetch({
    claude: () => ({
      content: [
        {
          type: "tool_use",
          input: {
            question: "What is the capital of Australia?",
            correct_answer: "Canberra",
            wrong_answers: ["Sydney", "Melbourne", "Perth"],
            explanation: "It was purpose-built as a compromise.",
          },
        },
      ],
    }),
  });
  await trivia(interaction("trivia"), {});
  const content = lastEdit(calls).body.content;
  for (const c of ["Canberra", "Sydney", "Melbourne", "Perth"]) assert.ok(content.includes(c));
  assert.match(content, /\|\|.*\*\*Canberra\*\*.*\|\|/);
});

test("/roast only reads the target's messages and only pings them", async () => {
  let prompt;
  const calls = mockFetch({
    claude: (body) => {
      prompt = body.messages[0].content;
      return { content: [{ type: "text", text: "You talk about trains a lot." }] };
    },
    discord: (url) =>
      url.includes("/channels/chan/messages?limit=100")
        ? [
            { author: { id: "friend" }, content: "the LIRR is late again" },
            { author: { id: "someone-else" }, content: "secret stuff" },
          ]
        : { id: "m" },
  });
  const i = interaction("roast", [{ name: "user", value: "friend" }], {
    resolved: { users: { friend: { id: "friend", username: "sam" } } },
  });
  await roast(i, {});

  assert.match(prompt, /LIRR is late/);
  assert.doesNotMatch(prompt, /secret stuff/);
  const edit = lastEdit(calls).body;
  assert.deepEqual(edit.allowed_mentions, { users: ["friend"] });
  assert.match(edit.content, /<@friend>/);
});

test("re-registers commands only when they changed since last time", async () => {
  let stored = null;
  const db = {
    prepare: (sql) => ({
      bind: (...args) => ({
        first: async () => (stored ? { value: stored } : null),
        run: async () => {
          if (sql.startsWith("INSERT")) stored = args[1];
        },
      }),
    }),
  };
  const calls = mockFetch({ claude: () => ({}), discord: (_u, init) => JSON.parse(init.body) });
  const env = { DB: db, DISCORD_APP_ID: "app123", DISCORD_TOKEN: "t" };

  await syncCommandsIfChanged(env);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://discord.com/api/v10/applications/app123/commands");

  await syncCommandsIfChanged(env);
  assert.equal(calls.length, 1, "no second registration when nothing changed");
});
