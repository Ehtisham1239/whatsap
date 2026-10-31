import { test } from "node:test";
import assert from "node:assert/strict";
import { inboundText, parseWebhook } from "../../src/meta/webhook-parser.js";

const wrap = (field, value) => ({ object: "whatsapp_business_account", entry: [{ id: "1001", time: 1761900000, changes: [{ field, value }] }] });
const meta = { display_phone_number: "15550001111", phone_number_id: "2002" };

test("parses an inbound text message with the contact profile name", () => {
  const { events, ignored } = parseWebhook(
    wrap("messages", {
      messaging_product: "whatsapp",
      metadata: meta,
      contacts: [{ wa_id: "923001234567", profile: { name: "Ali" } }],
      messages: [{ from: "923001234567", id: "wamid.IN1", timestamp: "1761900000", type: "text", text: { body: "Hello" } }],
    }),
  );
  assert.equal(ignored, 0);
  assert.deepEqual(events, [
    {
      kind: "inbound",
      key: "in:wamid.IN1",
      wabaId: "1001",
      phoneNumberId: "2002",
      wamid: "wamid.IN1",
      from: "923001234567",
      profileName: "Ali",
      timestamp: new Date(1761900000 * 1000),
      type: "text",
      content: { body: "Hello" },
      replyTo: null,
      ctwa: false,
    },
  ]);
  assert.equal(inboundText(events[0]), "Hello");
});

test("marks Click-to-WhatsApp referrals and extracts media, buttons and interactive replies", () => {
  const { events } = parseWebhook(
    wrap("messages", {
      metadata: meta,
      messages: [
        { from: "923001234567", id: "w1", timestamp: "1", type: "image", image: { id: "m1", mime_type: "image/jpeg", caption: "pic" }, referral: { source_type: "ad", ctwa_clid: "x" } },
        { from: "923001234567", id: "w2", timestamp: "1", type: "button", button: { text: "STOP", payload: "stop" } },
        { from: "923001234567", id: "w3", timestamp: "1", type: "interactive", interactive: { type: "button_reply", button_reply: { id: "b1", title: "Yes" } } },
        { from: "923001234567", id: "w4", timestamp: "1", type: "location", location: { latitude: 1, longitude: 2 } },
        { from: "923001234567", id: "w5", timestamp: "1", type: "unsupported", errors: [{ code: 131051 }] },
      ],
    }),
  );
  assert.equal(events[0].ctwa, true);
  assert.deepEqual(events[0].content, { media_id: "m1", mime_type: "image/jpeg", caption: "pic" });
  assert.equal(inboundText(events[1]), "STOP");
  assert.deepEqual(events[2].content, { interactive_type: "button_reply", id: "b1", title: "Yes" });
  assert.equal(inboundText(events[2]), "Yes");
  assert.equal(events[3].content.latitude, 1);
  assert.equal(events[4].content.unsupported, true);
  assert.equal(inboundText(events[3]), "");
});

test("parses statuses including failure details and pricing category", () => {
  const { events } = parseWebhook(
    wrap("messages", {
      metadata: meta,
      statuses: [
        { id: "wamid.OUT1", status: "delivered", timestamp: "1761900100", recipient_id: "923001234567", pricing: { category: "utility" } },
        { id: "wamid.OUT2", status: "failed", timestamp: "1761900100", errors: [{ code: 131026, title: "Message undeliverable", error_data: { details: "Receiver incapable" } }] },
      ],
    }),
  );
  assert.equal(events[0].key, "st:wamid.OUT1:delivered");
  assert.equal(events[0].pricingCategory, "utility");
  assert.equal(events[0].error, null);
  assert.deepEqual(events[1].error, { code: "131026", message: "Receiver incapable" });
});

test("parses template status updates", () => {
  const { events } = parseWebhook(wrap("message_template_status_update", { event: "REJECTED", message_template_id: 555, message_template_name: "promo", message_template_language: "en", reason: "INCORRECT_CATEGORY" }));
  assert.deepEqual(events[0], { kind: "template_status", key: "tpl:555:REJECTED:1761900000", wabaId: "1001", metaTemplateId: "555", name: "promo", language: "en", status: "rejected", reason: "INCORRECT_CATEGORY" });
  const none = parseWebhook(wrap("message_template_status_update", { event: "APPROVED", message_template_id: 1, reason: "NONE" }));
  assert.equal(none.events[0].reason, null);
});

test("ignores unknown objects, fields and malformed entries without throwing", () => {
  assert.deepEqual(parseWebhook(null), { events: [], ignored: 1 });
  assert.deepEqual(parseWebhook({ object: "page", entry: [] }), { events: [], ignored: 1 });
  assert.equal(parseWebhook(wrap("account_update", {})).ignored, 1);
  assert.equal(parseWebhook(wrap("messages", { messages: [{ id: "x", from: "1" }] })).ignored, 1);
  const r = parseWebhook(wrap("messages", { metadata: meta, messages: [{ id: "x" }], statuses: [{ id: "y", status: "deleted" }] }));
  assert.deepEqual(r, { events: [], ignored: 2 });
});
