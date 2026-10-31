import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb);
const PARAMS = { N: 16384, r: 8, p: 1 };
const KEYLEN = 32;
export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 200;

/** Format: scrypt$N$r$p$salt(base64url)$hash(base64url) */
export async function hashPassword(password, params = PARAMS) {
  const salt = randomBytes(16);
  const key = await scrypt(password.normalize("NFKC"), salt, KEYLEN, { ...params, maxmem: 64 * 1024 * 1024 });
  return ["scrypt", params.N, params.r, params.p, salt.toString("base64url"), key.toString("base64url")].join("$");
}

export async function verifyPassword(password, stored) {
  const parts = typeof stored === "string" ? stored.split("$") : [];
  if (parts.length !== 6 || parts[0] !== "scrypt" || typeof password !== "string") return false;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  if (![N, r, p].every(Number.isInteger) || N > 1 << 20) return false;
  const expected = Buffer.from(parts[5], "base64url");
  const key = await scrypt(password.normalize("NFKC"), Buffer.from(parts[4], "base64url"), expected.length, { N, r, p, maxmem: 64 * 1024 * 1024 });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** Returns an error message, or null when the password is acceptable. */
export function passwordProblem(password, { email, name } = {}) {
  if (typeof password !== "string") return "Password is required";
  if (password.length < MIN_PASSWORD_LENGTH) return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  if (password.length > MAX_PASSWORD_LENGTH) return `Password must be at most ${MAX_PASSWORD_LENGTH} characters`;
  const lower = password.toLowerCase();
  if (new Set(lower).size < 4) return "Password is too repetitive";
  const local = email ? String(email).split("@")[0].toLowerCase() : "";
  if ((local.length >= 4 && lower.includes(local)) || (name && name.length >= 4 && lower.includes(String(name).toLowerCase()))) return "Password must not contain your name or email";
  if (["password", "1234567890", "qwertyuiop", "whatsapp"].some((w) => lower.includes(w))) return "Password is too common";
  return null;
}

export function normalizeEmail(value) {
  if (typeof value !== "string") return null;
  const e = value.trim().toLowerCase();
  return e.length <= 254 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) ? e : null;
}
