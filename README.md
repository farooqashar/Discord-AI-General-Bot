# Ashistant (Discord AI General Bot)

A small Discord bot with Claude-powered slash commands. It runs on Cloudflare Workers, so there's no server to keep running and hosting is free. The only cost is Anthropic API usage, usually a fraction of a cent per command.

| Command | What it does |
| --- | --- |
| `/ask <question> [channel]` | Ask anything. Reads the last 20 messages first, so follow-ups like "wdym?" work; point it at another channel to ask about that chat. |
| `/tldr [user] [messages] [channel]` | A couple of plain sentences on what a channel has been talking about (last 50 messages, or 2–100). Pick a user to summarize just what they've been saying (searches the last 500 messages). |
| `/event <details>` | "board game night Saturday 8pm at my place" becomes a real Discord scheduled event, with an **Add to Google Calendar** button. |
| `/remind <reminder>` | "tomorrow at 6pm to book the restaurant" posts a reminder in the channel at that time. |
| `/research <question>` | Searches the web and posts a short report with sources in a new thread. |
| `/eli5 <topic>` | Explains anything like you're five. |
| `/decide <options>` | "pizza, sushi, tacos": picks one at random, with a dramatic justification. |
| `/trivia [topic]` | A multiple-choice trivia question with the answer hidden behind a spoiler. |
| `/food <craving> [area]` | Searches the web for 3–5 places to eat, with Google Maps links. Defaults to New York City. |
| `/summarize <link>` | Reads a web page or PDF and posts a short TL;DR with a "worth reading?" verdict. |
| `/vibe-check [channel] [messages]` | Reads a channel's last 200 messages (10–500) and reports its mood, topics, running jokes, most active people and peak hour. |
| `/weather [place]` | Current conditions and the next three days from Open-Meteo (free, no key). Defaults to New York; handles "Huntington, NY". |
| `/stats [channel] [days]` | Server-wide by default: most active people and channels, busiest day and hour, top words and emoji, links and files, and the most-reacted message (last 7 days, up to 30). Only counts channels everyone in the server can read, since the reply is public. Pick a channel for just that one. Plain counting, no AI, free. |
| `/digest setup topics:… [channel] [time]` | A short daily digest posted to a channel: at most 5 one-line bullets, each linked to its source. Also `now` (preview), `off`, `list`. Setup needs Manage Channels. |
| `/wrapped setup [channel] [about] [frequency] [day] [time]` | A scheduled weekly (or monthly) recap of the whole server or one channel: a one-line recap, messages and MVP, busiest channel, most-reacted and funniest message. Only covers channels everyone can see. Also `now`, `off`, `list`. |
| `/auto-pin setup channel rule [time] [report] [max]` | Once a day (default 11pm), pins up to 5 messages (or `max:` up to 20) from the last 24 hours in a channel that match a description, like "restaurant recs and confirmed plans". Never re-pins. The optional report channel gets jump links only, no message text. Also `now` (preview, pins nothing), `off`, `list`. Needs the Pin Messages permission. |
| `/catchup [channel] [public]` | What you missed since your last message in a channel (or the last 24 hours): a short summary plus links to anything that mentions, replies to or asks you something. Only you see it unless `public:true`, and it always stays private for private channels. |
| `/birthday set/remove/list/channel` | Save birthdays (month and day only). On the day, the bot posts a short wish in the chosen channel and pings the birthday person. Setting someone else's birthday or the channel needs Manage Channels. |
| `/countdown add/list/remove` | Count down to a date ("Japan trip", "March 14"). Shows days left, or hours, minutes and seconds on the last day, with a live Discord timer. When it hits zero, the bot posts an alert in the channel where it was started. Anyone can remove their own; Manage Channels can remove any. Up to 25 per server, 5 years ahead. |
| `/quotes random/site/setup/off` | The Quote Book. `/quotes setup channel:#quotes` (Manage Channels; the channel must be one everyone can see) imports the channel's quotes and keeps saving new ones every 5 minutes. `random` pulls one (optionally `from` someone or matching `search`), `site` links the members-only website. |
| `/listen [on/off/status]` | Turns on @mention replies in a channel (admins only). The bot then answers anyone who @mentions it or replies to its messages there, within about a minute. |
| `/roast @user [heat] [channel]` | Roasts someone based on their recent messages. Heat: mild, spicy (default) or savage. |

## How it works

Discord sends each slash command to the Worker as an HTTP request. The Worker checks Discord's signature, immediately replies "thinking…", then calls the Claude API in the background and edits the reply with the result. `/research` uses Claude's built-in web search tool. Reminders are stored in a Cloudflare D1 database and a cron trigger checks for due ones every minute. The same cron re-registers the slash commands whenever a deploy changes them, so new commands appear about a minute after you push.

```
src/
  index.js               Worker entry: routes commands, runs the every-minute cron
  register.js            Keeps Discord's command list in sync
  discord.js             Signature check, Discord API calls, message splitting
  claude.js              Anthropic API wrapper and structured extraction
  command-definitions.js Slash command names, descriptions and options
  commands/              One file per command
  web/                   Quote Book website and Sign in with Discord
scripts/register-commands.js   Registers the commands with Discord
migrations/                    D1 tables (the bot also creates them on first use)
```

## Setup

Everything is done in the GitHub, Cloudflare and Discord dashboards; no terminal needed. You need a GitHub account, a Cloudflare account and an Anthropic API key. Fork this repo first: you'll edit `wrangler.toml` in your fork, because the IDs in it belong to the original author's Cloudflare account and Discord app.

### 1. Create the Discord app

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) and click **New Application**.
2. On **General Information**, copy the **Application ID** and **Public Key**.
3. On **Bot**, click **Reset Token** and copy the token. Turn on **Message Content Intent** (needed for `/tldr`) and save.
4. Invite the bot to your server by opening this URL with your Application ID filled in:

   ```
   https://discord.com/oauth2/authorize?client_id=YOUR_APP_ID&scope=bot+applications.commands&permissions=2269709827378176
   ```

   That grants View Channels, Send Messages, Read Message History, Create Public Threads, Send Messages in Threads, Create/Manage Events, and Pin Messages (for `/auto-pin`). Re-opening the link on a server the bot is already in just updates its permissions.

### 2. Create the database

The bot stores reminders, the last registered command list and its other settings in a Cloudflare D1 database.

1. In the Cloudflare dashboard, go to **Storage & Databases → D1 → Create** and name it `discord-bot-reminders`. (From a terminal: `npx wrangler d1 create discord-bot-reminders`.)
2. Copy its **Database ID**.
3. In your fork, edit `wrangler.toml` (the pencil icon on GitHub works):
   - under `[[d1_databases]]`, set `database_id` to the ID you copied;
   - set `DISCORD_APP_ID` to your Application ID from step 1;
   - set `PUBLIC_URL` to your Worker's URL (`https://discord-ai-general-bot.<your workers subdomain>.workers.dev`; you can fix it after step 3 if you're not sure).

The bot creates its tables the first time it needs them, so you don't have to run the migrations. If you'd rather create them up front, run `npm run db:migrate`, or paste the files in `migrations/` into the database's **Console** tab in order.

### 3. Deploy on Cloudflare

1. In the Cloudflare dashboard, go to **Workers & Pages → Create → Import a repository** and pick your fork. Keep the default build settings and deploy. It redeploys on every push to `main`, and sets up the every-minute reminder check.
2. Open the Worker → **Settings → Variables and Secrets** and add three **Secrets**: `DISCORD_PUBLIC_KEY`, `DISCORD_TOKEN`, `ANTHROPIC_API_KEY`.
3. Copy the Worker's URL from its overview page (for example `https://discord-ai-general-bot.<you>.workers.dev`).

### 4. Connect Discord to the Worker

Back on the app's **General Information** page in Discord, paste the Worker URL into **Interactions Endpoint URL** and save. Discord pings the URL to check it, and the bot uses that ping to register its slash commands. They can take a minute to appear; if they don't show up, restart Discord.

Then try `/ask` in your server.

## @mentions

Discord only sends ordinary messages to bots that stay connected all the time, which this one doesn't. Instead, the every-minute cron checks the channels turned on with `/listen on` for new messages that @mention the bot or reply to it, and answers them as real replies, using the recent chat as context. Replies take up to about a minute. It never answers messages from before listening was turned on, and answers at most 5 mentions per channel per minute.

## Quote Book website

`/quotes site` links to `<worker url>/quotes/<server id>`. Visitors click **Sign in with Discord**; Discord tells the Worker who they are and which servers they're in (scopes `identify guilds`), and only members of that server see its quotes. Nobody else, including people who sign in but aren't in the server, sees anything. Sign-ins last 7 days, but the server list from sign-in isn't trusted for that long: at most every 15 minutes, before showing a server's quotes, the Worker asks Discord (with the bot token) whether the visitor is still a member. Someone who leaves or is kicked or banned loses access within 15 minutes. The check never signs a current member out, though every sign-in still ends after 7 days. If Discord doesn't confirm membership either way (an outage, or the bot has lost access to the server), the page asks them to try again in a minute rather than showing the quotes, the error goes to the Cloudflare logs, and Discord isn't asked again for that visitor and server until the minute is up. The Worker keeps only the user's ID, name and server list, never Discord's access token. The page has no JavaScript and escapes all quote text.

One-time setup:

1. Discord Developer Portal → your app → **OAuth2** → **Redirects** → add `https://<worker url>/auth/callback` and save. On the same page, copy the **Client Secret** (click Reset Secret if it's hidden).
2. Cloudflare → the Worker → **Settings → Variables and Secrets** → add `DISCORD_CLIENT_SECRET` as a **Secret**.
3. Make sure `PUBLIC_URL` in `wrangler.toml` is the Worker's URL.

## Scheduled posts

Digests and Wrapped recaps run on their own 5-minute cron trigger, separate from the every-minute one, so their requests never compete with reminders and @mentions for Cloudflare's per-run limit. Set times are rounded down to the nearest 5 minutes (11:58pm becomes 11:55pm), and posts become due at that time (Eastern, from `TIMEZONE`), once per day or period. Each run posts at most one Wrapped (it reads many channels), otherwise up to 5 digests, so when several are due at once the rest go out on the following runs, 5 or more minutes late.

## Using one bot channel

To keep the bot in a single channel, go to Server Settings → Integrations → the bot → Channels and allow only that channel. Commands that read chat (`/ask`, `/tldr`, `/vibe-check`, `/roast`, `/stats`) take a `channel` option to read a different channel and post the result where you ran them. The bot only reads a channel if the person asking can read it too. The result is posted publicly only when everyone in the server can read that channel; for a private channel (or a thread in one), only the person who asked sees the reply. Server-wide `/stats` counts only channels everyone can read.

## Changing things

- **Model:** set `CLAUDE_MODEL` in `wrangler.toml`. The default is `claude-haiku-5-5`; `claude-sonnet-5-5` gives stronger answers at a higher cost.
- **Time zone** for `/event` and `/remind`: set `TIMEZONE` in `wrangler.toml`.
- **Bot name:** set `BOT_NAME` in `wrangler.toml`. Replies use this name and never mention the underlying AI model or company. Error details go to the Cloudflare logs; Discord only shows a friendly message.
- **New or changed commands:** edit `src/command-definitions.js`, add a handler in `src/commands/`, and wire it into `HANDLERS` in `src/index.js`. Push, and the bot registers the new commands within a minute of deploying. If Discord doesn't show them, restart the Discord app.
- **Default `/food` area:** set `DEFAULT_AREA` in `wrangler.toml`.

## Costs and limits

- **Cloudflare:** the free plan covers this easily (100,000 requests a day, plus D1 and cron triggers).
- **Anthropic:** pay as you go. `/research` and `/food` also pay a per-search fee (1¢ each), capped at 4 and 3 searches per run. Set a monthly spend limit in the Anthropic Console.
- **Research time:** background work on Workers gets about 30 seconds after the "thinking…" reply. A capped research run normally fits. Slash commands give the AI about 25 seconds in total, then reply "⏱️ That took too long…" instead of hanging; if that happens often, move `/research` to a Cloudflare Workflow. Scheduled jobs give each AI call up to 60 seconds, then log it and move on.
- **Message length:** Discord messages max out at 2,000 characters, so long answers are split across several messages.
- **@mentions:** the bot doesn't stay connected to Discord, so it answers @mentions only in channels turned on with `/listen`, and up to about a minute late (see [@mentions](#mentions)).

## Tests

```bash
npm test
```
