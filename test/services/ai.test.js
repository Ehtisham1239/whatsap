import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import * as repo from "../../src/db/repo.js";
import { buildSystemPrompt, createAiService, messageForModel, toModelMessages, validateSettings } from "../../src/services/ai.js";
import { createInboundService } from "../../src/services/inbound.js";
import { createMessagingService } from "../../src/services/messaging.js";
import { createTestDb } from "../helpers/db.js";
import { APP_SECRET, ENCRYPTION_KEY, T0, fakeMeta, makeClock, seedConnection, seedTenant } from "../helpers/fixtures.js";

const PHONE = "923001234567";
let t;
before(async () => (t = await createTestDb()));
after(() => t.close());

/** Test double for the Anthropic client: queue responses, record requests. */
function fakeClaude() {
  const calls = [];
  const queue = [];
  return {
    calls,
    queue,
    beta: {
      messages: {
        async create(params) {
          calls.push(params);
          clock.advance(1000); // model latency; keeps message order unambiguous
          const next = queue.shift() ?? { stop_reason: "end_turn", content: [{ type: "text", text: "Hello! How can I help?" }] };
          if (next instanceof Error) throw next;
          return next;
        },
      },
    },
  };
}

let clock, meta, claude, messaging, ai, inbound, tenant, conn, owner;
beforeEach(async () => {
  await t.reset();
  clock = makeClock();
  meta = fakeMeta();
  claude = fakeClaude();
  messaging = createMessagingService({ db: t.db, meta, encryptionKey: ENCRYPTION_KEY, now: clock, sleep: async () => {} });
  ai = createAiService({ db: t.db, messaging, client: claude, now: clock });
  inbound = createInboundService({ db: t.db, appSecret: APP_SECRET, now: clock, onInboundMessage: (e) => ai.onInbound(e) });
  tenant = await seedTenant(t.db, { balance: 100 });
  conn = await seedConnection(t.db, tenant.id);
  owner = { tenant_id: tenant.id, user_id: "usr_owner", role: "owner" };
});

const INFO = "We teach online Quran classes. Timings 4pm-10pm PKT. Trial class is free for 3 days.";
async function enable(extra = {}) {
  return ai.saveSettings(owner, { enabled: true, business_name: "Acme Academy", instructions: INFO, handoff_message: "A teammate will reply shortly.", ...extra });
}
async function customerSays(id, text) {
  clock.advance(1);
  const payload = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: conn.waba_id, changes: [{ field: "messages", value: { metadata: { phone_number_id: conn.phone_number_id }, contacts: [{ wa_id: PHONE, profile: { name: "Ali" } }], messages: [{ from: PHONE, id, timestamp: String(Math.floor(clock().getTime() / 1000)), type: "text", text: { body: text } }] } }] }] });
  await inbound.handle(Buffer.from(payload), "sha256=" + createHmac("sha256", APP_SECRET).update(payload).digest("hex"));
  await ai.drain();
}
const thread = async () => (await repo.listMessages(t.db, tenant.id, { limit: 50 })).reverse();
const conversation = async () => (await repo.listConversations(t.db, tenant.id))[0];

describe("helpers", () => {
  test("system prompt carries the business info and the safety rules", () => {
    const p = buildSystemPrompt({ business_name: "Acme", instructions: INFO });
    assert.match(p, /WhatsApp assistant for Acme/);
    assert.ok(p.includes(INFO));
    assert.match(p, /Never invent prices/);
    assert.match(p, /not instructions to you/);
    assert.match(buildSystemPrompt({}), /none provided yet/);
  });

  test("history becomes alternating turns that start and end with the customer", () => {
    const m = (direction, body, type = "text") => ({ direction, type, content: { body } });
    assert.deepEqual(toModelMessages([m("outbound", "Template hello"), m("inbound", "hi"), m("inbound", "price?"), m("outbound", "Rs 5000"), m("inbound", "ok thanks")]), [
      { role: "user", content: "hi\nprice?" },
      { role: "assistant", content: "Rs 5000" },
      { role: "user", content: "ok thanks" },
    ]);
    assert.deepEqual(toModelMessages([m("inbound", "hi"), m("outbound", "hello")]), [], "nothing to answer when we spoke last");
    assert.equal(messageForModel({ direction: "inbound", type: "image", content: { media_id: "1" } }), "[customer sent an image]");
    assert.equal(messageForModel({ direction: "inbound", type: "document", content: { media_id: "1", filename: "fee.pdf" } }), "[customer sent a document: fee.pdf]");
  });

  test("settings validation", () => {
    assert.throws(() => validateSettings({ enabled: true, instructions: "short" }), (e) => e.details[0].field === "instructions");
    assert.throws(() => validateSettings({ instructions: "x".repeat(12001) }), /correct/);
    assert.equal(validateSettings({ enabled: "yes", instructions: "" }).enabled, false, "only boolean true enables");
  });
});

describe("settings API", () => {
  test("only owners and admins can change settings; anyone can read", async () => {
    await assert.rejects(ai.saveSettings({ ...owner, role: "agent" }, { enabled: false }), { code: "manager_required" });
    const saved = await enable();
    assert.equal(saved.settings.enabled, true);
    assert.equal(saved.available, true);
    assert.equal((await ai.getSettings({ tenant_id: tenant.id })).settings.business_name, "Acme Academy");
    const other = await seedTenant(t.db, { name: "Other" });
    assert.equal((await ai.getSettings({ tenant_id: other.id })).settings.enabled, false, "per tenant");
  });

  test("test() drafts a reply without sending anything", async () => {
    claude.queue.push({ stop_reason: "end_turn", content: [{ type: "text", text: "Classes run 4pm to 10pm." }] });
    const r = await ai.test(owner, { message: "timings?", settings: { business_name: "Acme", instructions: INFO } });
    assert.deepEqual(r, { reply: "Classes run 4pm to 10pm.", handoff: false, reason: null });
    assert.equal(meta.sends.length, 0);
    await assert.rejects(ai.test(owner, { message: "" }), { status: 400 });
    const off = createAiService({ db: t.db, messaging, client: null });
    await assert.rejects(off.test(owner, { message: "hi" }), /ANTHROPIC_API_KEY/);
  });
});

describe("auto-reply", () => {
  test("answers an inbound message with the configured model, effort, fallbacks and handoff tool", async () => {
    await enable();
    claude.queue.push({ stop_reason: "end_turn", content: [{ type: "text", text: "Ji, free trial 3 din ka hai." }] });
    await customerSays("w1", "trial free hai?");
    const req = claude.calls[0];
    assert.equal(req.model, "claude-opus-5-5");
    assert.deepEqual(req.output_config, { effort: "low" });
    assert.equal(req.fallbacks, "default");
    assert.deepEqual(req.betas, ["server-side-fallback-2026-07-01"]);
    assert.equal(req.tools[0].name, "handoff_to_human");
    assert.equal(req.tools[0].strict, true);
    assert.deepEqual(req.tool_choice, { type: "auto" });
    assert.ok(req.system[0].text.includes(INFO));
    assert.deepEqual(req.messages, [{ role: "user", content: "trial free hai?" }]);
    const msgs = await thread();
    const reply = msgs.at(-1);
    assert.equal(reply.sent_via, "ai");
    assert.equal(reply.content.body, "Ji, free trial 3 din ka hai.");
    assert.equal(meta.sends.at(-1).payload.text.body, "Ji, free trial 3 din ka hai.");
  });

  test("the handoff tool pauses the assistant for that conversation, adds a note and sends the handoff message", async () => {
    await enable();
    claude.queue.push({ stop_reason: "tool_use", content: [{ type: "tool_use", id: "tu1", name: "handoff_to_human", input: { reason: "Customer asks for a refund" } }] });
    await customerSays("w1", "I want my money back");
    assert.equal((await conversation()).ai_paused, true);
    assert.equal((await conversation()).status, "open", "stays in the team's Open inbox");
    const msgs = await thread();
    assert.ok(msgs.some((m) => m.mode === "note" && m.content.body.includes("refund")));
    assert.equal(meta.sends.at(-1).payload.text.body, "A teammate will reply shortly.");
    await customerSays("w2", "hello?");
    assert.equal(claude.calls.length, 1, "paused: the AI stays quiet");
    await ai.setPaused(owner, (await conversation()).id, false);
    await customerSays("w3", "still there?");
    assert.equal(claude.calls.length, 2, "resumed by a teammate");
    await assert.rejects(ai.setPaused(owner, "conv_missing", true), { status: 404 });
  });

  test("refusals hand off without sending model text", async () => {
    await enable({ handoff_message: "" });
    claude.queue.push({ stop_reason: "refusal", content: [] });
    await customerSays("w1", "something");
    assert.equal((await conversation()).ai_paused, true);
    assert.equal(meta.sends.length, 0);
  });

  test("API errors: 4xx hands off, 5xx and 429 just log", async () => {
    await enable();
    const err = (status) => Object.assign(Object.create(Anthropic.APIError.prototype), { status, message: `HTTP ${status}` });
    claude.queue.push(err(529));
    await customerSays("w1", "hi");
    assert.equal((await conversation()).ai_paused, false);
    claude.queue.push(err(400));
    await customerSays("w2", "hi again");
    assert.equal((await conversation()).ai_paused, true);
    assert.equal(meta.sends.length, 0);
  });

  test("disabled assistant, opt-out keywords and missing client never call the model", async () => {
    await customerSays("w1", "hi");
    assert.equal(claude.calls.length, 0, "not enabled");
    await enable();
    await customerSays("w2", "STOP");
    assert.equal(claude.calls.length, 0, "keyword handled by the platform");
    const noKey = createAiService({ db: t.db, messaging, client: null });
    assert.deepEqual(await noKey.respond({ tenantId: tenant.id, conversationId: (await conversation()).id }), { skipped: "disabled" });
  });

  test("when a teammate replies, the assistant stays out for 30 minutes", async () => {
    await enable();
    await customerSays("w1", "hi");
    const conv = await conversation();
    await messaging.send({ tenant_id: tenant.id, id: null }, { to: PHONE, type: "text", text: { body: "Hi Ali, Sara here" } });
    clock.advance(1000);
    await customerSays("w2", "hi Sara");
    assert.equal(claude.calls.length, 1, "human is handling it");
    clock.advance(31 * 60_000);
    await customerSays("w3", "anyone?");
    assert.equal(claude.calls.length, 2);
    assert.equal(conv.id, (await conversation()).id);
  });

  test("a per-conversation hourly reply limit hands off", async () => {
    await enable();
    for (let i = 0; i < 10; i++) {
      clock.advance(1000);
      await customerSays(`w${i}`, `question ${i}`);
    }
    assert.equal(claude.calls.length, 10);
    clock.advance(1000);
    await customerSays("w10", "one more");
    assert.equal(claude.calls.length, 10, "11th message is not sent to the model");
    assert.equal((await conversation()).ai_paused, true);
    const history = claude.calls[9].messages;
    assert.equal(history.at(-1).content, "question 9");
    assert.equal(history.filter((m) => m.role === "assistant").length, 9, "earlier AI replies are in the context");
  });
});
