// Pure helpers shared by the dashboard pages. No DOM access, so they are
// unit-tested in Node (test/unit/format.test.js).

/** "+92 300 1234567" style display for stored digits-only numbers. */
export function formatPhone(digits) {
  if (typeof digits !== "string" || !/^\d{8,15}$/.test(digits)) return String(digits ?? "");
  if (digits.startsWith("92") && digits.length === 12) return `+92 ${digits.slice(2, 5)} ${digits.slice(5)}`;
  if (digits.startsWith("1") && digits.length === 11) return `+1 ${digits.slice(1, 4)} ${digits.slice(4, 7)} ${digits.slice(7)}`;
  return `+${digits}`;
}

/** Short time for lists: "14:05" today, "Mon" this week, else "31 Oct". */
export function formatListTime(iso, now = new Date(), timeZone) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const opts = timeZone ? { timeZone } : {};
  const day = (x) => x.toLocaleDateString("en-CA", opts);
  if (day(d) === day(now)) return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", ...opts });
  if (now.getTime() - d.getTime() < 6 * 86400_000 && d < now) return d.toLocaleDateString("en-GB", { weekday: "short", ...opts });
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", ...opts });
}

export function formatDateTime(iso, timeZone) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", ...(timeZone ? { timeZone } : {}) });
}

/** Remaining service window as { open, label } e.g. "Window open · 5h 12m left". */
export function windowState(expiresIso, now = new Date()) {
  if (!expiresIso) return { open: false, label: "No reply window: send a template" };
  const ms = new Date(expiresIso).getTime() - now.getTime();
  if (!(ms > 0)) return { open: false, label: "Reply window closed: send a template" };
  const h = Math.floor(ms / 3600_000);
  const m = Math.floor((ms % 3600_000) / 60_000);
  return { open: true, label: `Reply window open · ${h ? `${h}h ` : ""}${m}m left` };
}

/** Delivery indicator for outbound messages. */
export function statusLabel(message) {
  if (message.mode === "note") return { icon: "", text: "Internal note" };
  if (message.direction === "inbound") return { icon: "", text: "" };
  const map = {
    scheduled: ["🕓", "Scheduled"],
    queued: ["⏳", "Sending"],
    sent: ["✓", "Sent"],
    delivered: ["✓✓", "Delivered"],
    read: ["✓✓", "Read"],
    failed: ["⚠", "Failed"],
    cancelled: ["✕", "Cancelled"],
  };
  const [icon, text] = map[message.status] ?? ["", message.status];
  return { icon, text };
}

/** One-line text for a message bubble or list preview. */
export function messageText(message) {
  const c = message.content || {};
  if (c.body) return c.body;
  if (c.caption) return c.caption;
  if (c.title) return c.title;
  if (c.text) return c.text;
  if (c.emoji) return `Reacted ${c.emoji}`;
  if (message.type === "location") return `📍 ${c.name || "Location"}${c.latitude !== undefined ? ` (${c.latitude}, ${c.longitude})` : ""}`;
  if (c.media?.link) return `[${message.type}] ${c.media.filename || c.media.link}`;
  if (c.media_id) return `[${message.type}${c.filename ? `: ${c.filename}` : ""}]`;
  if (c.unsupported) return "[Unsupported message type]";
  return `[${message.type}]`;
}

export function hasDownloadableMedia(message) {
  return message.direction === "inbound" && Boolean(message.content?.media_id);
}

/** Template variable names in send order ({{1}}, {{name}}). */
export function templateFields(template) {
  return Array.isArray(template?.variables) ? template.variables : [];
}

/** Credits for display with sign: "+500", "−10". */
export function formatCredits(n) {
  if (!Number.isFinite(n)) return "";
  if (n > 0) return `+${n.toLocaleString("en-US")}`;
  if (n < 0) return `−${Math.abs(n).toLocaleString("en-US")}`;
  return "0";
}

/** Normalises user input like "0300 1234567" with a default country code. */
export function toInternational(input, defaultCountryCode = "92") {
  let s = String(input ?? "").replace(/[\s().-]/g, "");
  if (s.startsWith("+")) s = s.slice(1);
  else if (s.startsWith("00")) s = s.slice(2);
  else if (/^0[1-9]/.test(s) && defaultCountryCode) s = defaultCountryCode + s.slice(1);
  return /^[1-9]\d{7,14}$/.test(s) ? s : null;
}

/** Turns an API error JSON into one readable sentence. */
export function errorMessage(err) {
  const e = err?.error ?? err;
  if (!e) return "Something went wrong";
  if (Array.isArray(e.details) && e.details.length) return `${e.message}: ${e.details.map((d) => `${d.field} ${d.message}`).join("; ")}`;
  return e.message || "Something went wrong";
}

/** Case-insensitive filter of conversations by name, phone or preview. */
export function filterConversations(list, query) {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return list;
  const digits = q.replace(/\D/g, "");
  return list.filter((c) => (c.contact_name || "").toLowerCase().includes(q) || (digits && c.phone.includes(digits)) || (c.last_preview || "").toLowerCase().includes(q));
}

/** RFC 4180-ish CSV parser: quoted fields, escaped quotes, CRLF, blank lines skipped. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  const s = String(text ?? "").replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === "," || ch === ";" || ch === "\t") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && s[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows.map((r) => r.map((f) => f.trim()));
}

/**
 * Turns CSV with a header row (phone, then one column per template variable)
 * into broadcast recipients. Returns { recipients, errors, columns }.
 */
export function recipientsFromCsv(text, templateVariables = [], defaultCountryCode = "92") {
  const rows = parseCsv(text);
  if (!rows.length) return { recipients: [], errors: ["The list is empty"], columns: [] };
  const header = rows[0].map((h) => h.replace(/^\{\{\s*|\s*\}\}$/g, "").toLowerCase());
  const phoneCol = header.findIndex((h) => ["phone", "to", "number", "mobile", "whatsapp"].includes(h));
  const errors = [];
  if (phoneCol === -1) return { recipients: [], errors: ['The first row must be a header with a "phone" column'], columns: header };
  const missing = templateVariables.filter((v) => !header.includes(String(v).toLowerCase()));
  if (missing.length) errors.push(`Missing columns for template variables: ${missing.map((v) => `{{${v}}}`).join(", ")}`);
  const recipients = [];
  rows.slice(1).forEach((r, i) => {
    const to = toInternational(r[phoneCol], defaultCountryCode);
    if (!to) {
      errors.push(`Row ${i + 2}: "${r[phoneCol] ?? ""}" is not a valid phone number`);
      return;
    }
    const variables = {};
    for (const v of templateVariables) {
      const idx = header.indexOf(String(v).toLowerCase());
      if (idx !== -1) variables[v] = r[idx] ?? "";
    }
    const empty = Object.entries(variables).filter(([, val]) => !val).map(([k]) => `{{${k}}}`);
    if (empty.length) errors.push(`Row ${i + 2}: empty ${empty.join(", ")}`);
    recipients.push({ to: `+${to}`, variables });
  });
  if (!recipients.length && !errors.length) errors.push("No recipients found below the header row");
  return { recipients, errors, columns: header };
}
