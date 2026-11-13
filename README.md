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
scripts/register-commands.js   Registers the commands with Discord
migrations/                    D1 table for reminders
```

## Setup

Everything is done in the Cloudflare and Discord dashboards; no terminal needed. You need a Cloudflare account and an Anthropic API key. The reminders database (`discord-bot-reminders`) already exists and is set in `wrangler.toml`.

### 1. Create the Discord app

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) and click **New Application**.
2. On **General Information**, copy the **Application ID** and **Public Key**.
3. On **Bot**, click **Reset Token** and copy the token. Turn on **Message Content Intent** (needed for `/tldr`) and save.
4. Invite the bot to your server by opening this URL with your Application ID filled in:

   ```
   https://discord.com/oauth2/authorize?client_id=YOUR_APP_ID&scope=bot+applications.commands&permissions=17910013692928
   ```

   That grants View Channels, Send Messages, Read Message History, Create Public Threads, Send Messages in Threads, and Create/Manage Events.

### 2. Deploy on Cloudflare

1. In the Cloudflare dashboard, go to **Workers & Pages → Create → Import a repository** and pick this repo. Keep the default build settings and deploy. It redeploys on every push to `main`, and sets up the every-minute reminder check.
2. Open the Worker → **Settings → Variables and Secrets** and add three **Secrets**: `DISCORD_PUBLIC_KEY`, `DISCORD_TOKEN`, `ANTHROPIC_API_KEY`.
3. Copy the Worker's URL from its overview page (for example `https://discord-ai-general-bot.<you>.workers.dev`).

### 3. Connect Discord to the Worker

Back on the app's **General Information** page in Discord, paste the Worker URL into **Interactions Endpoint URL** and save. Discord pings the URL to check it, and the bot uses that ping to register its slash commands. They can take a minute to appear; if they don't show up, restart Discord.

Then try `/ask` in your server.

## @mentions

Discord only sends ordinary messages to bots that stay connected all the time, which this one doesn't. Instead, the every-minute cron checks the channels turned on with `/listen on` for new messages that @mention the bot or reply to it, and answers them as real replies, using the recent chat as context. Replies take up to about a minute. It never answers messages from before listening was turned on, and answers at most 5 mentions per channel per minute.

## Using one bot channel

To keep the bot in a single channel, go to Server Settings → Integrations → the bot → Channels and allow only that channel. Commands that read chat (`/ask`, `/tldr`, `/vibe-check`, `/roast`) take a `channel` option to read a different channel and post the result where you ran them. The bot only reads a channel if the person asking can read it too.

## Changing things

- **Model:** set `CLAUDE_MODEL` in `wrangler.toml`. The default is `claude-haiku-5-5`; `claude-sonnet-5-5` gives stronger answers at a higher cost.
- **Time zone** for `/event` and `/remind`: set `TIMEZONE` in `wrangler.toml`.
- **Bot name:** set `BOT_NAME` in `wrangler.toml`. Replies use this name and never mention the underlying AI model or company. Error details go to the Cloudflare logs; Discord only shows a friendly message.
- **New or changed commands:** edit `src/command-definitions.js`, add a handler in `src/commands/`, and wire it into `HANDLERS` in `src/index.js`. Push, and the bot registers the new commands within a minute of deploying. If Discord doesn't show them, restart the Discord app.
- **Default `/food` area:** set `DEFAULT_AREA` in `wrangler.toml`.

## Costs and limits

- **Cloudflare:** the free plan covers this easily (100,000 requests a day, plus D1 and cron triggers).
- **Anthropic:** pay as you go. `/research` and `/food` also pay a per-search fee (1¢ each), capped at 4 and 3 searches per run. Set a monthly spend limit in the Anthropic Console.
- **Research time:** background work on Workers gets about 30 seconds after the "thinking…" reply. A capped research run normally fits; if very long questions get cut off, move `/research` to a Cloudflare Workflow.
- **Message length:** Discord messages max out at 2,000 characters, so long answers are split across several messages.
- This bot only responds to slash commands. Replying to @mentions or watching every message would need an always-on bot connected to Discord's gateway.

## Tests

```bash
npm test
```
