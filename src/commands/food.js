import { formatSources, webSearch } from "../claude.js";
import { getOption, replyWithText } from "../discord.js";

const SYSTEM = `You recommend places to eat. Search the web for current, well-reviewed spots,
then reply in Discord markdown with 3–5 picks. For each pick, one bullet:
**[Name](<https://www.google.com/maps/search/?api=1&query=NAME+NEIGHBORHOOD+CITY>)**: neighborhood, price ($–$$$$), and one line on what to order or why it's good.
In the maps link, URL-encode the query (spaces as +). Only include places that appear to be open (not permanently closed).
No intro sentence and no sources list; sources are added automatically. Never use @everyone or @here.`;

export async function food(interaction, env) {
  const craving = getOption(interaction, "craving");
  const area = getOption(interaction, "area") || env.DEFAULT_AREA || "New York, NY";

  const { text, sources } = await webSearch(env, {
    system: SYSTEM,
    prompt: `Where should I go for ${craving} in or near ${area}?`,
    maxSearches: 3,
    maxTokens: 1200,
    location: { city: "New York", region: "New York", country: "US", timezone: env.TIMEZONE || "America/New_York" },
  });

  const picks = text || "I couldn't find good spots for that. Try a different craving or area?";
  const sourceList = formatSources(sources, 4);
  await replyWithText(
    env,
    interaction,
    `🍜 **${craving}** near **${area}**\n\n${picks}${sourceList ? `\n\n${sourceList}` : ""}`,
  );
}
