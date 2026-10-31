import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Parses a base64 (or base64url) 32-byte key used for AES-256-GCM. */
export function parseEncryptionKey(value) {
  if (typeof value !== "string" || !value) throw new Error("TOKEN_ENCRYPTION_KEY is not set");
  const key = Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (key.length !== 32) throw new Error("TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes");
  return key;
}

/** Encrypts a WABA access token for `waba_connections.token_cipher`. Format: v1.<iv>.<tag>.<ciphertext> (base64url). */
export function encryptSecret(plaintext, key, aad = "") {
  if (typeof plaintext !== "string" || !plaintext) throw new TypeError("plaintext must be a non-empty string");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  if (aad) cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), ct.toString("base64url")].join(".");
}

export function decryptSecret(token, key, aad = "") {
  const parts = typeof token === "string" ? token.split(".") : [];
  if (parts.length !== 4 || parts[0] !== "v1") throw new Error("unsupported secret format");
  const [, iv, tag, ct] = parts.map((p, i) => (i === 0 ? p : Buffer.from(p, "base64url")));
  if (iv.length !== 12 || tag.length !== 16) throw new Error("unsupported secret format");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  if (aad) decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

function randomBase62(length) {
  // Rejection sampling keeps the distribution uniform.
  let out = "";
  while (out.length < length) {
    for (const b of randomBytes(length * 2)) {
      if (b < 248) out += BASE62[b % 62];
      if (out.length === length) break;
    }
  }
  return out;
}

/** API keys are hashed with a server-side pepper so a database leak alone cannot verify keys. */
export function hashApiKey(key, pepper) {
  if (!pepper) throw new Error("API_KEY_PEPPER is not set");
  return createHmac("sha256", pepper).update(key).digest("hex");
}

/** Returns the plaintext key (show once), its display prefix and the stored hash. */
export function generateApiKey(pepper, { environment = "live" } = {}) {
  if (!/^(live|test)$/.test(environment)) throw new TypeError("environment must be live or test");
  const key = `wa_${environment}_${randomBase62(32)}`;
  return { key, prefix: key.slice(0, 12), hash: hashApiKey(key, pepper) };
}

export function looksLikeApiKey(value) {
  return typeof value === "string" && /^wa_(live|test)_[0-9A-Za-z]{32}$/.test(value);
}

/** Verifies Meta's `X-Hub-Signature-256: sha256=<hex>` over the exact raw request body. */
export function verifyMetaSignature(rawBody, header, appSecret) {
  if (!appSecret || typeof header !== "string" || !header.startsWith("sha256=")) return false;
  const given = header.slice(7);
  if (!/^[0-9a-f]{64}$/i.test(given)) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest("hex");
  return safeEqual(expected, given.toLowerCase());
}

/** Signature header for webhooks we deliver to tenants: `t=<unix>,v1=<hex hmac of "t.body">`. */
export function signTenantWebhook(body, secret, timestampSeconds) {
  const mac = createHmac("sha256", secret).update(`${timestampSeconds}.${body}`).digest("hex");
  return `t=${timestampSeconds},v1=${mac}`;
}

export function verifyTenantWebhook(body, header, secret, nowSeconds, toleranceSeconds = 300) {
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header || "");
  if (!m) return false;
  const t = Number(m[1]);
  if (Math.abs(nowSeconds - t) > toleranceSeconds) return false;
  return safeEqual(signTenantWebhook(body, secret, t), header);
}

export function generateWebhookSecret() {
  return `whsec_${randomBase62(32)}`;
}

export function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** Stable JSON (sorted keys) so the same idempotent request always hashes identically. */
export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
    .join(",")}}`;
}
