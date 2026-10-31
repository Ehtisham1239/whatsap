import { test } from "node:test";
import assert from "node:assert/strict";
import {
  errorMessage, filterConversations, formatCredits, formatListTime, formatPhone, hasDownloadableMedia, messageText,
  statusLabel, templateFields, toInternational, windowState,
} from "../../public/assets/format.js";

const now = new Date("2026-10-31T10:00:00Z");

test("formatPhone", () => {
  assert.equal(formatPhone("923001234567"), "+92 300 1234567");
  assert.equal(formatPhone("15551234567"), "+1 555 123 4567");
  assert.equal(formatPhone("447700900123"), "+447700900123");
  assert.equal(formatPhone("abc"), "abc");
  assert.equal(formatPhone(undefined), "");
});

test("formatListTime shows time today, weekday this week, date otherwise", () => {
  assert.equal(formatListTime("2026-10-31T08:05:00Z", now, "UTC"), "08:05");
  assert.equal(formatListTime("2026-10-29T08:05:00Z", now, "UTC"), "Thu");
  assert.equal(formatListTime("2026-09-01T08:05:00Z", now, "UTC"), "1 Sept");
  assert.equal(formatListTime("nope", now), "");
});

test("windowState", () => {
  assert.deepEqual(windowState(null, now), { open: false, label: "No reply window: send a template" });
  assert.equal(windowState("2026-10-31T09:59:00Z", now).open, false);
  assert.deepEqual(windowState("2026-10-31T15:12:30Z", now), { open: true, label: "Reply window open · 5h 12m left" });
  assert.equal(windowState("2026-10-31T10:30:00Z", now).label, "Reply window open · 30m left");
});

test("statusLabel", () => {
  assert.deepEqual(statusLabel({ direction: "outbound", status: "read" }), { icon: "✓✓", text: "Read" });
  assert.deepEqual(statusLabel({ direction: "outbound", status: "failed" }), { icon: "⚠", text: "Failed" });
  assert.deepEqual(statusLabel({ direction: "inbound", status: "received" }), { icon: "", text: "" });
  assert.equal(statusLabel({ mode: "note", direction: "outbound", status: "sent" }).text, "Internal note");
  assert.deepEqual(statusLabel({ direction: "outbound", status: "weird" }), { icon: "", text: "weird" });
});

test("messageText covers each content shape", () => {
  assert.equal(messageText({ content: { body: "hi" } }), "hi");
  assert.equal(messageText({ type: "image", content: { caption: "pic", media_id: "1" } }), "pic");
  assert.equal(messageText({ type: "interactive", content: { title: "Yes" } }), "Yes");
  assert.equal(messageText({ type: "button", content: { text: "STOP" } }), "STOP");
  assert.equal(messageText({ type: "reaction", content: { emoji: "👍" } }), "Reacted 👍");
  assert.equal(messageText({ type: "location", content: { latitude: 1, longitude: 2 } }), "📍 Location (1, 2)");
  assert.equal(messageText({ type: "document", content: { media: { link: "https://x/a.pdf", filename: "a.pdf" } } }), "[document] a.pdf");
  assert.equal(messageText({ type: "document", content: { media_id: "1", filename: "a.pdf" } }), "[document: a.pdf]");
  assert.equal(messageText({ type: "unknown", content: { unsupported: true } }), "[Unsupported message type]");
  assert.equal(messageText({ type: "sticker", content: null }), "[sticker]");
});

test("hasDownloadableMedia only for inbound media", () => {
  assert.ok(hasDownloadableMedia({ direction: "inbound", content: { media_id: "1" } }));
  assert.ok(!hasDownloadableMedia({ direction: "outbound", content: { media_id: "1" } }));
  assert.ok(!hasDownloadableMedia({ direction: "inbound", content: { body: "x" } }));
});

test("templateFields, formatCredits, toInternational", () => {
  assert.deepEqual(templateFields({ variables: ["1", "2"] }), ["1", "2"]);
  assert.deepEqual(templateFields(undefined), []);
  assert.equal(formatCredits(500), "+500");
  assert.equal(formatCredits(-1500), "−1,500");
  assert.equal(formatCredits(0), "0");
  assert.equal(formatCredits(NaN), "");
  assert.equal(toInternational("0300 1234567"), "923001234567");
  assert.equal(toInternational("+44 7700 900123"), "447700900123");
  assert.equal(toInternational("0044 7700 900123"), "447700900123");
  assert.equal(toInternational("12"), null);
  assert.equal(toInternational("0300 1234567", null), null);
});

test("errorMessage", () => {
  assert.equal(errorMessage({ error: { message: "Nope" } }), "Nope");
  assert.equal(errorMessage({ error: { message: "Request validation failed", details: [{ field: "to", message: "is invalid" }] } }), "Request validation failed: to is invalid");
  assert.equal(errorMessage(null), "Something went wrong");
});

test("filterConversations by name, digits and preview", () => {
  const list = [
    { contact_name: "Ali Khan", phone: "923001234567", last_preview: "Order shipped" },
    { contact_name: null, phone: "447700900123", last_preview: "Hello" },
  ];
  assert.equal(filterConversations(list, "").length, 2);
  assert.equal(filterConversations(list, "ali")[0].phone, "923001234567");
  assert.equal(filterConversations(list, "+44 7700")[0].phone, "447700900123");
  assert.equal(filterConversations(list, "SHIPPED").length, 1);
  assert.equal(filterConversations(list, "zzz").length, 0);
});

test("parseCsv handles quotes, separators, CRLF and blank lines", async () => {
  const { parseCsv } = await import("../../public/assets/format.js");
  assert.deepEqual(parseCsv('phone,name\r\n"+92 300 1111111","Khan, Ali"\n\n923002222222;"Sara ""S"""\n'), [
    ["phone", "name"],
    ["+92 300 1111111", "Khan, Ali"],
    ["923002222222", 'Sara "S"'],
  ]);
  assert.deepEqual(parseCsv("﻿a\tb"), [["a", "b"]]);
  assert.deepEqual(parseCsv(""), []);
});

test("recipientsFromCsv maps columns to template variables and reports problems", async () => {
  const { recipientsFromCsv } = await import("../../public/assets/format.js");
  const ok = recipientsFromCsv("Phone,{{1}},2\n0300 1111111,Ali,A-1\n+44 7700 900123,Sara,B-2", ["1", "2"]);
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.recipients, [
    { to: "+923001111111", variables: { 1: "Ali", 2: "A-1" } },
    { to: "+447700900123", variables: { 1: "Sara", 2: "B-2" } },
  ]);
  const bad = recipientsFromCsv("phone,first_name\n12,Ali\n923001111111,", ["first_name", "order"]);
  assert.deepEqual(bad.errors, ["Missing columns for template variables: {{order}}", 'Row 2: "12" is not a valid phone number', "Row 3: empty {{first_name}}"]);
  assert.match(recipientsFromCsv("name\nAli", []).errors[0], /phone/);
  assert.deepEqual(recipientsFromCsv("", []).errors, ["The list is empty"]);
  assert.deepEqual(recipientsFromCsv("phone", []).errors, ["No recipients found below the header row"]);
});
