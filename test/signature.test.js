import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../src/index.js";
import { MAX_SIGNATURE_AGE_SECONDS, verifyDiscordRequest } from "../src/discord.js";

const toHex = (buf) => Buffer.from(buf).toString("hex");
const now = () => Math.floor(Date.now() / 1000);

async function makeKeys() {
  const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const publicKeyHex = toHex(await crypto.subtle.exportKey("raw", keys.publicKey));
  return { privateKey: keys.privateKey, publicKeyHex };
}

// A request correctly signed over `timestamp + body`, whatever the timestamp says.
async function signedRequest(privateKey, payload, timestamp) {
  const body = JSON.stringify(payload);
  const sig = await crypto.subtle.sign("Ed25519", privateKey, new TextEncoder().encode(timestamp + body));
  return new Request("https://bot.example/", {
    method: "POST",
    headers: { "X-Signature-Ed25519": toHex(sig), "X-Signature-Timestamp": timestamp },
    body,
  });
}

test("accepts a correctly signed request with a current timestamp", async () => {
  const { privateKey, publicKeyHex } = await makeKeys();
  const fresh = await signedRequest(privateKey, { type: 1 }, String(now()));
  assert.equal((await verifyDiscordRequest(fresh, publicKeyHex)).valid, true);

  const nearLimit = await signedRequest(privateKey, { type: 1 }, String(now() - MAX_SIGNATURE_AGE_SECONDS + 10));
  assert.equal((await verifyDiscordRequest(nearLimit, publicKeyHex)).valid, true);
});

test("rejects a correctly signed request an hour old, and the worker answers 401", async () => {
  const { privateKey, publicKeyHex } = await makeKeys();
  const old = String(now() - 3600);
  const stale = await signedRequest(privateKey, { type: 1 }, old);
  const result = await verifyDiscordRequest(stale, publicKeyHex);
  assert.equal(result.valid, false);
  assert.equal(result.body, JSON.stringify({ type: 1 }));

  const replay = await signedRequest(privateKey, { type: 1 }, old);
  const res = await worker.fetch(replay, { DISCORD_PUBLIC_KEY: publicKeyHex }, { waitUntil() {} });
  assert.equal(res.status, 401);
});

test("rejects a timestamp just past the age limit", async () => {
  const { privateKey, publicKeyHex } = await makeKeys();
  const req = await signedRequest(privateKey, { type: 1 }, String(now() - MAX_SIGNATURE_AGE_SECONDS - 10));
  assert.equal((await verifyDiscordRequest(req, publicKeyHex)).valid, false);
});

test("rejects a timestamp far in the future", async () => {
  const { privateKey, publicKeyHex } = await makeKeys();
  const req = await signedRequest(privateKey, { type: 1 }, String(now() + 3600));
  assert.equal((await verifyDiscordRequest(req, publicKeyHex)).valid, false);
});

test("rejects a timestamp that isn't a whole number of seconds", async () => {
  const { privateKey, publicKeyHex } = await makeKeys();
  for (const timestamp of ["soon", `${now()}.5`, ` ${now()}`, `-${now()}`, "1e9"]) {
    const req = await signedRequest(privateKey, { type: 1 }, timestamp);
    assert.equal((await verifyDiscordRequest(req, publicKeyHex)).valid, false, timestamp);
  }
});
