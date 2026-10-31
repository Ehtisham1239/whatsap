import { test } from "node:test";
import assert from "node:assert/strict";
import { validateIdempotencyKey, validateSendRequest } from "../../src/lib/validation.js";

const now = new Date("2026-10-31T10:00:00Z");
const fields = (r) => (r.errors || []).map((e) => e.field);

test("valid text request is normalised", () => {
  const r = validateSendRequest({ to: "+92 300 1234567", type: "text", text: { body: "Hi" } }, { now });
  assert.deepEqual(r.value, { to: "923001234567", type: "text", text: { body: "Hi", preview_url: false } });
});

test("national numbers use the default country code when given", () => {
  const r = validateSendRequest({ to: "03001234567", type: "text", text: { body: "Hi" } }, { now, defaultCountryCode: "92" });
  assert.equal(r.value.to, "923001234567");
});

test("text body is required and bounded", () => {
  assert.deepEqual(fields(validateSendRequest({ to: "923001234567", type: "text", text: { body: " " } }, { now })), ["text.body"]);
  assert.deepEqual(fields(validateSendRequest({ to: "923001234567", type: "text", text: { body: "x".repeat(4097) } }, { now })), ["text.body"]);
  assert.ok(validateSendRequest({ to: "923001234567", type: "text", text: { body: "x".repeat(4096) } }, { now }).value);
});

test("media requests validate link, caption and filename", () => {
  assert.deepEqual(validateSendRequest({ to: "923001234567", type: "document", media: { link: "https://x.test/a.pdf", caption: "Invoice", filename: "a.pdf" } }, { now }).value.media, { link: "https://x.test/a.pdf", caption: "Invoice", filename: "a.pdf" });
  assert.deepEqual(fields(validateSendRequest({ to: "923001234567", type: "image", media: { link: "http://x.test/a.png" } }, { now })), ["media.link"]);
  assert.deepEqual(fields(validateSendRequest({ to: "923001234567", type: "audio", media: { link: "https://x.test/a.ogg", caption: "no" } }, { now })), ["media.caption"]);
  assert.deepEqual(fields(validateSendRequest({ to: "923001234567", type: "image", media: { link: "https://x.test/a.png", filename: "a.png" } }, { now })), ["media.filename"]);
  assert.deepEqual(fields(validateSendRequest({ to: "923001234567", type: "document", media: { link: "https://x.test/a.pdf", filename: "../a.pdf" } }, { now })), ["media.filename"]);
});

test("template requests validate name, language and variables", () => {
  const ok = validateSendRequest({ to: "923001234567", type: "template", template: { name: "otp", language: "en_US", variables: { 1: "123" } } }, { now });
  assert.deepEqual(ok.value.template, { name: "otp", language: "en_US", variables: { 1: "123" } });
  const bad = validateSendRequest({ to: "923001234567", type: "template", template: { name: "OTP", language: "english", variables: [] } }, { now });
  assert.deepEqual(fields(bad).sort(), ["template.language", "template.name", "template.variables"]);
  assert.deepEqual(fields(validateSendRequest({ to: "923001234567", type: "template" }, { now })), ["template"]);
});

test("unknown fields, bad type and bad recipient are reported together", () => {
  const r = validateSendRequest({ to: "123", type: "sticker", extra: 1 }, { now });
  assert.deepEqual(fields(r).sort(), ["extra", "to", "type"]);
  assert.deepEqual(fields(validateSendRequest(null)), ["body"]);
  assert.deepEqual(fields(validateSendRequest([])), ["body"]);
});

test("schedule_at must be a future ISO time with zone within 30 days", () => {
  const base = { to: "923001234567", type: "text", text: { body: "Hi" } };
  assert.deepEqual(validateSendRequest({ ...base, schedule_at: "2026-11-01T10:00:00Z" }, { now }).value.schedule_at, new Date("2026-11-01T10:00:00Z"));
  assert.ok(validateSendRequest({ ...base, schedule_at: "2026-11-01T15:00:00+05:00" }, { now }).value);
  for (const s of ["2026-10-31T09:00:00Z", "2026-10-31T10:00:00Z", "2026-12-15T10:00:00Z", "2026-11-01T10:00:00", "tomorrow", 123]) {
    assert.deepEqual(fields(validateSendRequest({ ...base, schedule_at: s }, { now })), ["schedule_at"], String(s));
  }
});

test("waba_connection_id and client_reference", () => {
  const base = { to: "923001234567", type: "text", text: { body: "Hi" } };
  assert.equal(validateSendRequest({ ...base, waba_connection_id: "waba_abc123", client_reference: "order-1" }, { now }).value.waba_connection_id, "waba_abc123");
  assert.deepEqual(fields(validateSendRequest({ ...base, waba_connection_id: "x; drop" }, { now })), ["waba_connection_id"]);
  assert.deepEqual(fields(validateSendRequest({ ...base, client_reference: "x".repeat(129) }, { now })), ["client_reference"]);
});

test("validateIdempotencyKey", () => {
  assert.deepEqual(validateIdempotencyKey(undefined), { value: null });
  assert.deepEqual(validateIdempotencyKey("order-1"), { value: "order-1" });
  assert.ok(validateIdempotencyKey("has space").error);
  assert.ok(validateIdempotencyKey("x".repeat(256)).error);
  assert.ok(validateIdempotencyKey("ünïcode").error);
});
