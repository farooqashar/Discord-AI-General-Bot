import { callClaude, textOf } from "../claude.js";
import { discordApi, editOriginal, getOption, invokingUser, splitMessage } from "../discord.js";

const SYSTEM = `You write a short, affectionate roast of a friend in a Discord group chat.
It should feel like teasing between friends: clever, playful, and never actually hurtful.
Base it on how they write and what they talk about in the messages provided, or on their name if there are none.
Never joke about appearance, body, race, ethnicity, religion, gender, sexuality, disability, health, money troubles,
family, or anything that sounds like a real personal struggle. No slurs or profanity.
3–4 sentences, end on something warm. Never use @everyone or @here.`;

export async function roast(interaction, env) {
  const targetId = getOption(interaction, "user");
  const user = interaction.data.resolved?.users?.[targetId];
  const member = interaction.data.resolved?.members?.[targetId];
  const name = member?.nick ?? user?.global_name ?? user?.username ?? "this person";

  if (user?.bot) {
    const me = invokingUser(interaction);
    await editOriginal(env, interaction, {
      content: `🤖 Roasting a bot? Bold move, <@${me.id}>. I'll let it off with a warning.`,
      allowed_mentions: { users: [] },
    });
    return;
  }

  // Their recent messages in this channel give Claude something to work with.
  const recent = await discordApi(env, `/channels/${interaction.channel_id}/messages?limit=100`);
  const theirs = recent
    .filter((m) => m.author?.id === targetId && m.content?.trim())
    .slice(0, 30)
    .map((m) => `- ${m.content.slice(0, 300)}`)
    .reverse();

  const context = theirs.length
    ? `Their recent messages:\n${theirs.join("\n")}`
    : "They haven't said anything recently in this channel (which is itself roastable).";

  const message = await callClaude(env, {
    max_tokens: 400,
    system: SYSTEM,
    messages: [{ role: "user", content: `Roast my friend "${name}".\n\n${context}` }],
  });

  const text = `🔥 <@${targetId}>\n\n${textOf(message)}`;
  // Only ping the person being roasted, never anyone else.
  await editOriginal(env, interaction, {
    content: splitMessage(text)[0],
    allowed_mentions: { users: [targetId] },
  });
}
