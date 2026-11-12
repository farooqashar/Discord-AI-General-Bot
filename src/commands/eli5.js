import { callClaude, textOf } from "../claude.js";
import { getOption, replyWithText } from "../discord.js";

const SYSTEM = `Explain things the way you would to a curious five-year-old.
Use short sentences, everyday words, and one vivid comparison to something a kid knows
(toys, snacks, playgrounds, pets). No jargon. Keep it to one short paragraph, 4–6 sentences.
It's fine to be a little playful. Never use @everyone or @here.`;

export async function eli5(interaction, env) {
  const topic = getOption(interaction, "topic");

  const message = await callClaude(env, {
    max_tokens: 500,
    system: SYSTEM,
    messages: [{ role: "user", content: `Explain like I'm five: ${topic}` }],
  });

  await replyWithText(env, interaction, `🧸 **ELI5: ${topic}**\n\n${textOf(message)}`);
}
