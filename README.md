# Discord AI General Bot

A small Discord bot with five Claude-powered slash commands. It runs on Cloudflare Workers, so there's no server to keep running and hosting is free. The only cost is Anthropic API usage, usually a fraction of a cent per command.

| Command | What it does |
| --- | --- |
| `/ask <question>` | Ask Claude anything; the answer posts in the channel. |
| `/tldr [messages]` | Summarizes the last 50 messages (or 10–100) in the channel. |
| `/event <details>` | "board game night Saturday 8pm at my place" becomes a real Discord scheduled event. |
| `/remind <reminder>` | "tomorrow at 6pm to book the restaurant" posts a reminder in the channel at that time. |
| `/research <question>` | Searches the web and posts a short report with sources in a new thread. |

## How it works

Discord sends each slash command to the Worker as an HTTP request. The Worker checks Discord's signature, immediately replies "thinking…", then calls the Claude API in the background and edits the reply with the result. `/research` uses Claude's built-in web search tool. Reminders are stored in a Cloudflare D1 database and a cron trigger checks for due ones every minute.

```
src/
  index.js               Worker entry: routes commands, runs the reminder cron
  discord.js             Signature check, Discord API calls, message splitting
  claude.js              Anthropic API wrapper and structured extraction
  command-definitions.js Slash command names, descriptions and options
  commands/              One file per command
scripts/register-commands.js   Registers the commands with Discord
migrations/                    D1 table for reminders
```

## Setup

You need Node 20+, a Cloudflare account, and an Anthropic API key.

### 1. Create the Discord app

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) and click **New Application**.
2. On **General Information**, copy the **Application ID** and **Public Key**.
3. On **Bot**, click **Reset Token** and copy the token. Turn on **Message Content Intent** (needed for `/tldr`).
4. Invite the bot to your server by opening this URL with your Application ID filled in:

   ```
   https://discord.com/oauth2/authorize?client_id=YOUR_APP_ID&scope=bot+applications.commands&permissions=17910013692928
   ```

   That grants View Channels, Send Messages, Read Message History, Create Public Threads, Send Messages in Threads, and Create/Manage Events.

### 2. Configure and register commands

```bash
npm install
cp .dev.vars.example .dev.vars   # then fill in the values
npm run register                 # adds the slash commands to your server
```

### 3. Create the reminders database

```bash
npx wrangler login
npx wrangler d1 create discord-bot-reminders
```

Paste the `database_id` it prints into `wrangler.toml`, then:

```bash
npm run db:migrate
```

### 4. Add secrets and deploy

```bash
npx wrangler secret put DISCORD_PUBLIC_KEY
npx wrangler secret put DISCORD_TOKEN
npx wrangler secret put ANTHROPIC_API_KEY
npm run deploy
```

### 5. Point Discord at the Worker

Copy the Worker URL that `deploy` prints (for example `https://discord-ai-general-bot.<you>.workers.dev`) into **Interactions Endpoint URL** on the app's **General Information** page and save. Discord pings the URL to check the signature verification before it saves.

Try `/ask` in your server.

## Changing things

- **Model:** set `CLAUDE_MODEL` in `wrangler.toml`. The default is `claude-haiku-5-5`; `claude-sonnet-5-5` gives stronger answers at a higher cost.
- **Time zone** for `/event` and `/remind`: set `TIMEZONE` in `wrangler.toml`.
- **New or changed commands:** edit `src/command-definitions.js`, add a handler in `src/commands/`, wire it into `HANDLERS` in `src/index.js`, then run `npm run register` and `npm run deploy`.
- **Auto-deploy:** connect this repo in the Cloudflare dashboard (Workers → your Worker → Settings → Builds) to deploy on every push to `main`.

## Costs and limits

- **Cloudflare:** the free plan covers this easily (100,000 requests a day, plus D1 and cron triggers).
- **Anthropic:** pay as you go. `/research` also pays a per-search fee and is capped at 4 searches per run. Set a monthly spend limit in the Anthropic Console.
- **Research time:** background work on Workers gets about 30 seconds after the "thinking…" reply. A capped research run normally fits; if very long questions get cut off, move `/research` to a Cloudflare Workflow.
- **Message length:** Discord messages max out at 2,000 characters, so long answers are split across several messages.
- This bot only responds to slash commands. Replying to @mentions or watching every message would need an always-on bot connected to Discord's gateway.

## Tests

```bash
npm test
```
