// Helpers for talking to Discord: request verification, REST calls,
// interaction replies, and splitting long text into Discord-sized messages.

const API = "https://discord.com/api/v10";

export const InteractionType = { PING: 1, APPLICATION_COMMAND: 2 };
export const ResponseType = {
  PONG: 1,
  CHANNEL_MESSAGE: 4,
  DEFERRED_CHANNEL_MESSAGE: 5, // shows "Bot is thinking…" until we edit it
};
export const EPHEMERAL = 1 << 6;

// Never let AI-written text ping @everyone, roles or users by accident.
export const NO_MENTIONS = { parse: [] };

const DISCORD_LIMIT = 2000;

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

let cachedKey;
let cachedKeyHex;

/**
 * Discord signs every interaction request. We must check the signature,
 * or Discord refuses to save our endpoint URL (and anyone could call it).
 */
export async function verifyDiscordRequest(request, publicKeyHex) {
  const signature = request.headers.get("X-Signature-Ed25519");
  const timestamp = request.headers.get("X-Signature-Timestamp");
  const body = await request.text();
  if (!signature || !timestamp || !publicKeyHex) return { valid: false, body };

  try {
    if (!cachedKey || cachedKeyHex !== publicKeyHex) {
      cachedKey = await crypto.subtle.importKey(
        "raw",
        hexToBytes(publicKeyHex),
        { name: "Ed25519" },
        false,
        ["verify"],
      );
      cachedKeyHex = publicKeyHex;
    }
    const valid = await crypto.subtle.verify(
      "Ed25519",
      cachedKey,
      hexToBytes(signature),
      new TextEncoder().encode(timestamp + body),
    );
    return { valid, body };
  } catch {
    return { valid: false, body };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Call the Discord REST API. Uses the bot token unless `auth: false`
 * (interaction webhooks are authorized by their token in the URL).
 */
export async function discordApi(env, path, { method = "GET", body, auth = true } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (auth) headers.Authorization = `Bot ${env.DISCORD_TOKEN}`;

  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${API}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (res.status === 429) {
      // Rate limited: wait as long as Discord asks, then try again.
      const data = await res.json().catch(() => ({}));
      await sleep(Math.ceil((data.retry_after ?? 1) * 1000));
      continue;
    }
    if (!res.ok) {
      const text = await res.text();
      const err = new Error(`Discord ${method} ${path.split("?")[0]} failed (${res.status}): ${text.slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }
    return res.status === 204 ? null : res.json();
  }
  throw new Error(`Discord ${method} ${path} kept getting rate limited`);
}

/** Replace the "Bot is thinking…" placeholder with real content. */
export async function editOriginal(env, interaction, data) {
  const path = `/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`;
  // Our background work can start a moment before Discord has registered the
  // deferred reply, which shows up as a 404. Give it a beat and retry.
  for (let attempt = 0; ; attempt++) {
    try {
      return await discordApi(env, path, { method: "PATCH", body: data, auth: false });
    } catch (err) {
      if (err.status === 404 && attempt < 3) {
        await sleep(500);
        continue;
      }
      throw err;
    }
  }
}

/** Post an extra message as part of the same command reply. */
export function followUp(env, interaction, data) {
  return discordApi(env, `/webhooks/${interaction.application_id}/${interaction.token}`, {
    method: "POST",
    body: data,
    auth: false,
  });
}

/** Post a message to a channel or thread as the bot. */
export function sendChannelMessage(env, channelId, data) {
  return discordApi(env, `/channels/${channelId}/messages`, { method: "POST", body: data });
}

/**
 * Split text into chunks that fit Discord's 2,000-character limit,
 * preferring paragraph, then line, then word boundaries.
 */
export function splitMessage(text, limit = DISCORD_LIMIT - 50) {
  const chunks = [];
  let rest = text.trim();
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n\n", limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf("\n", limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf(" ", limit);
    if (cut <= 0) cut = limit;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks.length ? chunks : [""];
}

/** Reply to a deferred command with text of any length. */
export async function replyWithText(env, interaction, text) {
  const [first, ...more] = splitMessage(text);
  await editOriginal(env, interaction, { content: first, allowed_mentions: NO_MENTIONS });
  for (const chunk of more) {
    await followUp(env, interaction, { content: chunk, allowed_mentions: NO_MENTIONS });
  }
}

/** Read a slash command option's value by name. */
export function getOption(interaction, name) {
  return interaction.data.options?.find((o) => o.name === name)?.value;
}

/** The Discord user who ran the command (works in servers and DMs). */
export function invokingUser(interaction) {
  return interaction.member?.user ?? interaction.user;
}

/** Discord's <t:…> format renders in each viewer's own time zone. */
export function discordTimestamp(date, style = "F") {
  return `<t:${Math.floor(date.getTime() / 1000)}:${style}>`;
}


/** A row of link buttons (style 5) under a message. */
export function linkButtons(buttons) {
  return [
    {
      type: 1,
      components: buttons.map(({ label, url, emoji }) => ({
        type: 2,
        style: 5,
        label,
        url,
        ...(emoji ? { emoji: { name: emoji } } : {}),
      })),
    },
  ];
}
