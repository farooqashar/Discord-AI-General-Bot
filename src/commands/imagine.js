import { NO_MENTIONS, editOriginalWithFile, getOption } from "../discord.js";

// Cloudflare's own image model: covered by Workers AI's free daily allowance,
// and needs no extra API key.
const IMAGE_MODEL = "@cf/black-forest-labs/flux-1-schnell";

export async function imagine(interaction, env) {
  const prompt = getOption(interaction, "prompt");
  if (!env.AI) throw new Error("Image generation isn't set up (missing the Workers AI binding)");

  const result = await env.AI.run(IMAGE_MODEL, {
    prompt,
    steps: 6, // 4 is the default; a couple more steps looks noticeably better
    seed: crypto.getRandomValues(new Uint32Array(1))[0],
  });
  if (!result?.image) throw new Error("The image model didn't return an image");

  const bytes = Uint8Array.from(atob(result.image), (ch) => ch.charCodeAt(0));
  const quoted = prompt.length > 300 ? `${prompt.slice(0, 300)}…` : prompt;

  await editOriginalWithFile(
    env,
    interaction,
    { content: `🎨 *${quoted.replace(/\*/g, "")}*`, allowed_mentions: NO_MENTIONS },
    { name: "imagine.jpg", type: "image/jpeg", bytes },
  );
}
