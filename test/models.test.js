import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { buildRequest, callClaude, extractStructured } from "../src/claude.js";
import { food } from "../src/commands/food.js";
import { UserFacingError } from "../src/discord.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const form = {
  max_tokens: 1024,
  system: "Fill in the form.",
  messages: [{ role: "user", content: "x" }],
  tools: [{ name: "fill", input_schema: { type: "object" } }],
  tool_choice: { type: "tool", name: "fill" },
};

test("on Haiku, forced forms turn thinking off and every request has room to think", () => {
  const req = buildRequest({ CLAUDE_MODEL: "claude-haiku-5-5" }, form);
  assert.equal(req.model, "claude-haiku-5-5");
  assert.deepEqual(req.tool_choice, { type: "tool", name: "fill" });
  assert.deepEqual(req.thinking, { type: "disabled" });
  assert.ok(req.max_tokens >= 4096);

  const chat = buildRequest({}, { max_tokens: 300, messages: [] });
  assert.equal(chat.thinking, undefined, "normal replies keep adaptive thinking");
  assert.ok(chat.max_tokens >= 4096);
});

test("on Fable, forced forms become a plain instruction instead of a forced tool", () => {
  const req = buildRequest({ CLAUDE_MODEL: "claude-fable-5-2" }, form);
  assert.deepEqual(req.tool_choice, { type: "auto" });
  assert.equal(req.thinking, undefined);
  assert.match(req.system, /Respond only by calling the fill tool/);
});

test("extractStructured still works when the model thinks first", async () => {
  globalThis.fetch = async () =>
    Response.json({
      stop_reason: "tool_use",
      content: [
        { type: "thinking", thinking: "" },
        { type: "tool_use", name: "fill", input: { ok: true } },
      ],
    });
  const out = await extractStructured(
    { CLAUDE_MODEL: "claude-fable-5-2" },
    { system: "s", prompt: "p", toolName: "fill", description: "d", schema: { type: "object" } },
  );
  assert.deepEqual(out, { ok: true });
});

test("a refusal becomes a friendly message", async () => {
  globalThis.fetch = async () => Response.json({ stop_reason: "refusal", content: [] });
  await assert.rejects(callClaude({}, { messages: [] }), (err) => {
    assert.ok(err instanceof UserFacingError);
    assert.equal(err.message, "I can't help with that one.");
    return true;
  });
});

test("/food uses the place in the craving and doesn't force New York", async () => {
  let request;
  const edits = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("anthropic")) {
      request = JSON.parse(init.body);
      return Response.json({
        stop_reason: "end_turn",
        content: [
          { type: "web_search_tool_result", content: [{ url: "https://a.kg", title: "A" }] },
          { type: "text", text: "- **[Navat](<https://maps>)**: central Bishkek" },
        ],
      });
    }
    edits.push(JSON.parse(init.body));
    return Response.json({ id: "1" });
  };
  await food(
    {
      application_id: "app",
      token: "tok",
      data: { options: [{ name: "craving", value: "horse meat in bishkek" }] },
    },
    { DEFAULT_AREA: "New York, NY" },
  );

  assert.match(request.messages[0].content, /horse meat in bishkek/);
  assert.match(request.messages[0].content, /If it names a city or neighborhood, find places there/);
  assert.equal(request.tools[0].user_location, undefined);
  assert.match(edits[0].content, /^🍜 \*\*horse meat in bishkek\*\*\n/);
  assert.doesNotMatch(edits[0].content, /near \*\*New York/);
  assert.match(edits[0].content, /Navat/);
});

test("error codes are short and never mention the provider", async () => {
  const { errorRef } = await import("../src/index.js");
  assert.equal(errorRef(new Error("Too many subrequests.")), "limit");
  assert.equal(errorRef(new Error("Discord GET /x kept getting rate limited")), "discord-429");
  assert.equal(errorRef(Object.assign(new Error("Discord GET /x failed (500): boom"), { status: 500 })), "discord-500");
  assert.equal(errorRef(new Error('AI request failed (529): {"error":"overloaded"}')), "ai-529");
  assert.equal(errorRef(new TypeError("x is undefined")), "typeerror");
});
