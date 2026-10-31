// Contacts store international numbers as digits only (country code first),
// matching the database check `phone ~ '^[1-9][0-9]{7,14}$'`.
const VALID = /^[1-9][0-9]{7,14}$/;

/**
 * Normalises user input to the stored digits-only format.
 * Accepts "+92 300 1234567", "0092-300-1234567", "(92) 3001234567".
 * A national number with a single leading 0 ("03001234567") is converted only
 * when `defaultCountryCode` is given. Returns null when the result is invalid.
 */
export function normalizePhone(input, { defaultCountryCode } = {}) {
  if (typeof input !== "string" && typeof input !== "number") return null;
  let s = String(input).trim();
  if (!s) return null;
  if (/[^0-9+\s().-]/.test(s)) return null;
  const hadPlus = s.startsWith("+");
  if (s.indexOf("+", 1) !== -1) return null;
  s = s.replace(/[\s().+-]/g, "");
  if (!hadPlus && s.startsWith("00")) s = s.slice(2);
  else if (!hadPlus && /^0[1-9]/.test(s)) {
    if (!defaultCountryCode || !/^[1-9][0-9]{0,2}$/.test(String(defaultCountryCode))) return null;
    s = String(defaultCountryCode) + s.slice(1);
  }
  return VALID.test(s) ? s : null;
}

export function isValidStoredPhone(value) {
  return typeof value === "string" && VALID.test(value);
}

/** "923001234567" -> "+92300•••4567" for logs and UI lists. */
export function maskPhone(value) {
  if (!isValidStoredPhone(value)) return "invalid";
  return `+${value.slice(0, value.length - 7)}•••${value.slice(-4)}`;
}
