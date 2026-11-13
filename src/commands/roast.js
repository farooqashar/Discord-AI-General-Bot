import { callClaude, textOf } from "../claude.js";
import { discordApi, editOriginal, getOption, invokingUser, splitMessage, targetChannel } from "../discord.js";

// Hard limits that apply at every heat level.
const LIMITS = `Base the roast on how they write and what they talk about in the messages provided,
or on their name if there are none. Never joke about race, ethnicity, religion, gender, sexuality,
disability, body or appearance, health or mental health, money troubles, family, grief, or anything
that sounds like a real personal struggle. No slurs, no threats, nothing sexual. Never use @everyone or @here.`;

const HEAT = {
  mild: `Write a short, affectionate roast of a friend in a Discord group chat: gentle teasing,
clever and playful. 3–4 sentences, ending on something warm.`,
  spicy: `Write a sharp roast of a friend in a Discord group chat, like a comedy roast between close friends.
Go for real punchlines: exaggerate their habits, call out what they keep talking about, quote their own
messages back at them. Confident and cutting, no softening or compliments. 3–5 sentences.`,
  savage: `Write a brutal comedy-roast-style takedown of a friend in a Discord group chat, the kind that makes
the whole chat say "oof". Merciless about their habits, takes, typing style and the things they won't stop
talking about; quote their messages back at them. Mild swearing is fine. No softening, no compliments,
no "but we love you". 4–6 sentences.`,
};

export async function roast(interaction, env) {
  const targetId = getOption(interaction, "user");
  const channelId = targetChannel(interaction, "roast from");
  const heat = HEAT[getOption(interaction, "heat")] ? getOption(interaction, "heat") : "spicy";
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

  // Their recent messages in that channel give the roast something to work with.
  const recent = await discordApi(env, `/channels/${channelId}/messages?limit=100`);
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
    system: `${HEAT[heat]}\n\n${LIMITS}`,
    messages: [{ role: "user", content: `Roast my friend "${name}".\n\n${context}` }],
  });

  const flames = { mild: "🔥", spicy: "🔥🔥", savage: "🔥🔥🔥" }[heat];
  const text = `${flames} <@${targetId}>\n\n${textOf(message)}`;
  // Only ping the person being roasted, never anyone else.
  await editOriginal(env, interaction, {
    content: splitMessage(text)[0],
    allowed_mentions: { users: [targetId] },
  });
}
