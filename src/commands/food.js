import { formatSources, webSearch } from "../claude.js";
import { getOption, replyWithText } from "../discord.js";

const SYSTEM = `You recommend places to eat. Search the web for current, well-reviewed spots,
then reply in Discord markdown with 3–5 picks. For each pick, one bullet:
**[Name](<https://www.google.com/maps/search/?api=1&query=NAME+NEIGHBORHOOD+CITY>)**: neighborhood, price ($–$$$$), and one line on what to order or why it's good.
In the maps link, URL-encode the query (spaces as +). Only include places that appear to be open (not permanently closed).
If you can't find good options, say so in one sentence and suggest what to search for instead.
No intro sentence and no sources list; sources are added automatically. Never use @everyone or @here.`;

export async function food(interaction, env) {
  const craving = getOption(interaction, "craving");
  const area = getOption(interaction, "area");
  const fallbackArea = env.DEFAULT_AREA || "New York, NY";

  // An explicit area wins. Otherwise the craving may already name a place
  // ("horse meat in Bishkek"), and the default area is only a fallback.
  const prompt = area
    ? `Where should I go for ${craving} in or near ${area}?`
    : `Request: "${craving}". If it names a city or neighborhood, find places there. ` +
      `If it doesn't name a place, find places in or near ${fallbackArea}.`;

  const { text, sources } = await webSearch(env, {
    system: SYSTEM,
    prompt,
    maxSearches: 3,
  });

  const picks = text || "I couldn't find good spots for that. Try a different craving or area?";
  const sourceList = formatSources(sources, 4);
  const heading = area ? `🍜 **${craving}** near **${area}**` : `🍜 **${craving}**`;
  await replyWithText(env, interaction, `${heading}\n\n${picks}${sourceList ? `\n\n${sourceList}` : ""}`);
}
