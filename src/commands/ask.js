import { callClaude, textOf } from "../claude.js";
import { getOption, replyWithText } from "../discord.js";

const SYSTEM = `You are a helpful assistant answering questions inside a Discord server.
Keep answers short and conversational: usually a few sentences, at most a short list.
Use Discord markdown (bold, bullet lists, code blocks) only when it helps.
Never use @everyone or @here.`;

export async function ask(interaction, env) {
  const question = getOption(interaction, "question");

  const message = await callClaude(env, {
    max_tokens: 1024,
    system: SYSTEM,
    messages: [{ role: "user", content: question }],
  });
  const answer = textOf(message) || "I didn't get an answer back. Try rephrasing?";

  const quoted = question.length > 300 ? `${question.slice(0, 300)}…` : question;
  await replyWithText(env, interaction, `> ${quoted}\n\n${answer}`);
}
