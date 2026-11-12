import { callClaude, textOf } from "../claude.js";
import { getOption, replyWithText } from "../discord.js";

const SYSTEM = `You are an overly dramatic judge announcing a decision that has already been made.
In 2–3 sentences, justify the chosen option with theatrical confidence and a bit of humor,
as if it were destiny. Mention the losing options briefly if it's funny. Don't change the choice.
Never use @everyone or @here.`;

/** "pizza, sushi or tacos" → ["pizza", "sushi", "tacos"] */
export function parseOptions(text) {
  const parts = text.includes(",") || text.includes("|") ? text.split(/[,|]/) : text.split(/\s+or\s+/i);
  const options = parts.map((p) => p.replace(/^\s*or\s+/i, "").trim()).filter(Boolean);
  return [...new Set(options)];
}

export async function decide(interaction, env) {
  const options = parseOptions(getOption(interaction, "options"));
  if (options.length < 2) {
    await replyWithText(
      env,
      interaction,
      '🤔 Give me at least two options, separated by commas, like `pizza, sushi, tacos`.',
    );
    return;
  }

  // The pick is truly random; Claude only supplies the drama.
  const choice = options[crypto.getRandomValues(new Uint32Array(1))[0] % options.length];

  const message = await callClaude(env, {
    max_tokens: 300,
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: `Options: ${options.join(" | ")}\nThe chosen option is: ${choice}`,
      },
    ],
  });

  await replyWithText(
    env,
    interaction,
    `🎲 **${options.join("** vs **")}**\n\n👉 **${choice}**\n\n${textOf(message)}`,
  );
}
