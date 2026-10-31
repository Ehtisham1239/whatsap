import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"; // Crockford base32, lower case

export const ID_PREFIXES = Object.freeze({
  tenant: "ten",
  waba: "waba",
  apiKey: "key",
  contact: "ct",
  conversation: "conv",
  template: "tpl",
  message: "msg",
  ledger: "led",
  webhookEndpoint: "whe",
  user: "usr",
});

/** Returns `<prefix>_<20 random base32 chars>` (100 bits of entropy). */
export function newId(prefix, random = randomBytes) {
  if (!/^[a-z]{2,8}$/.test(prefix)) throw new TypeError(`invalid id prefix: ${prefix}`);
  const bytes = random(20);
  let out = "";
  for (let i = 0; i < 20; i++) out += ALPHABET[bytes[i] & 31];
  return `${prefix}_${out}`;
}

export function hasPrefix(id, prefix) {
  return typeof id === "string" && new RegExp(`^${prefix}_[0-9a-z]{20}$`).test(id);
}
