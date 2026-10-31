import { normalizePhone } from "./phone.js";
import { isHttpsUrl, isValidTemplateName } from "./templates.js";

export const MEDIA_TYPES = Object.freeze(["image", "video", "audio", "document"]);
export const MAX_TEXT_LENGTH = 4096;
export const MAX_CAPTION_LENGTH = 1024;
const LANGUAGE = /^[a-z]{2,3}(_[A-Z]{2})?$/;
const MAX_SCHEDULE_AHEAD_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Validates POST /v1/messages and returns a normalised request or { errors }.
 *
 *   { to, type: "text", text: { body, preview_url? } }
 *   { to, type: "image"|"video"|"audio"|"document", media: { link, caption?, filename? } }
 *   { to, type: "template", template: { name, language, variables?, header_media? } }
 *   optional: waba_connection_id, schedule_at (ISO 8601), client_reference
 */
export function validateSendRequest(body, { now = new Date(), defaultCountryCode } = {}) {
  const errors = [];
  if (!body || typeof body !== "object" || Array.isArray(body)) return { errors: [{ field: "body", message: "must be a JSON object" }] };
  const allowed = new Set(["to", "type", "text", "media", "template", "waba_connection_id", "schedule_at", "client_reference"]);
  for (const k of Object.keys(body)) if (!allowed.has(k)) errors.push({ field: k, message: "unknown field" });

  const to = normalizePhone(body.to, { defaultCountryCode });
  if (!to) errors.push({ field: "to", message: "must be an international phone number, e.g. +923001234567" });

  const type = body.type;
  const out = { to, type };
  if (type === "text") {
    const t = body.text;
    if (!t || typeof t.body !== "string" || !t.body.trim()) errors.push({ field: "text.body", message: "is required" });
    else if (t.body.length > MAX_TEXT_LENGTH) errors.push({ field: "text.body", message: `must be at most ${MAX_TEXT_LENGTH} characters` });
    else out.text = { body: t.body, preview_url: t.preview_url === true };
  } else if (MEDIA_TYPES.includes(type)) {
    const m = body.media;
    if (!m || !isHttpsUrl(m.link)) errors.push({ field: "media.link", message: "must be an https URL" });
    else {
      out.media = { link: m.link };
      if (m.caption !== undefined) {
        if (type === "audio") errors.push({ field: "media.caption", message: "is not supported for audio" });
        else if (typeof m.caption !== "string" || m.caption.length > MAX_CAPTION_LENGTH) errors.push({ field: "media.caption", message: `must be a string of at most ${MAX_CAPTION_LENGTH} characters` });
        else out.media.caption = m.caption;
      }
      if (m.filename !== undefined) {
        if (type !== "document") errors.push({ field: "media.filename", message: "is only supported for documents" });
        else if (typeof m.filename !== "string" || !m.filename || m.filename.length > 240 || /[/\\]/.test(m.filename)) errors.push({ field: "media.filename", message: "is invalid" });
        else out.media.filename = m.filename;
      }
    }
  } else if (type === "template") {
    const t = body.template;
    if (!t || typeof t !== "object") errors.push({ field: "template", message: "is required" });
    else {
      if (!isValidTemplateName(t.name)) errors.push({ field: "template.name", message: "must match ^[a-z0-9_]+$" });
      if (typeof t.language !== "string" || !LANGUAGE.test(t.language)) errors.push({ field: "template.language", message: "must be a language code such as en or en_US" });
      if (t.variables !== undefined && (typeof t.variables !== "object" || t.variables === null || Array.isArray(t.variables))) errors.push({ field: "template.variables", message: "must be an object" });
      if (t.header_media !== undefined && !isHttpsUrl(t.header_media?.link)) errors.push({ field: "template.header_media.link", message: "must be an https URL" });
      out.template = { name: t.name, language: t.language, variables: t.variables ?? {}, ...(t.header_media ? { header_media: { link: t.header_media.link } } : {}) };
    }
  } else {
    errors.push({ field: "type", message: `must be one of text, template, ${MEDIA_TYPES.join(", ")}` });
  }

  if (body.waba_connection_id !== undefined) {
    if (typeof body.waba_connection_id !== "string" || !/^waba_[0-9a-z]{1,64}$/.test(body.waba_connection_id)) errors.push({ field: "waba_connection_id", message: "is invalid" });
    else out.waba_connection_id = body.waba_connection_id;
  }
  if (body.schedule_at !== undefined) {
    const at = typeof body.schedule_at === "string" && /^\d{4}-\d{2}-\d{2}T/.test(body.schedule_at) ? new Date(body.schedule_at) : null;
    if (!at || Number.isNaN(at.getTime()) || !/(Z|[+-]\d{2}:\d{2})$/.test(body.schedule_at)) errors.push({ field: "schedule_at", message: "must be an ISO 8601 timestamp with a time zone" });
    else if (at.getTime() <= now.getTime()) errors.push({ field: "schedule_at", message: "must be in the future" });
    else if (at.getTime() - now.getTime() > MAX_SCHEDULE_AHEAD_MS) errors.push({ field: "schedule_at", message: "must be within 30 days" });
    else out.schedule_at = at;
  }
  if (body.client_reference !== undefined) {
    if (typeof body.client_reference !== "string" || body.client_reference.length > 128) errors.push({ field: "client_reference", message: "must be a string of at most 128 characters" });
    else out.client_reference = body.client_reference;
  }
  return errors.length ? { errors } : { value: out };
}

/** Idempotency-Key header: 1-255 visible ASCII characters. */
export function validateIdempotencyKey(value) {
  if (value === undefined || value === null || value === "") return { value: null };
  if (typeof value !== "string" || !/^[\x21-\x7e]{1,255}$/.test(value)) return { error: "Idempotency-Key must be 1-255 visible ASCII characters" };
  return { value };
}
