import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import * as repo from "../../src/db/repo.js";
import { createInboundService, keywordIntent } from "../../src/services/inbound.js";
import { createMessagingService } from "../../src/services/messaging.js";
import { createTestDb } from "../helpers/db.js";
import { APP_SECRET, ENCRYPTION_KEY, T0, balanceOf, fakeMeta, makeClock, recordingNotifier, seedConnection, seedTemplate, seedTenant } from "../helpers/fixtures.js";

const PHONE = "923001234567";
const ts = (d) => String(Math.floor(d.getTime() / 1000));
let t;
before(async () => (t = await createTestDb()));
after(() => t.close());

let clock, notifier, inbound, messaging, meta, tenant, conn;
beforeEach(async () => {
  await t.reset();
  clock = makeClock();
  notifier = recordingNotifier();
  meta = fakeMeta();
  inbound = createInboundService({ db: t.db, appSecret: APP_SECRET, now: clock, notifier });
  messaging = createMessagingService({ db: t.db, meta, encryptionKey: ENCRYPTION_KEY, now: clock, notifier, sleep: async () => {} });
  tenant = await seedTenant(t.db, { balance: 100 });
  conn = await seedConnection(t.db, tenant.id);
});

function sign(payload) {
  const raw = Buffer.from(JSON.stringify(payload));
  return [raw, "sha256=" + createHmac("sha256", APP_SECRET).update(raw).digest("hex")];
}
const deliver = (payload) => inbound.handle(...sign(payload));
const envelope = (value, field = "messages") => ({ object: "whatsapp_business_account", entry: [{ id: conn.waba_id, time: 1761904800, changes: [{ field, value }] }] });
const inMsg = (id, body, extra = {}) =>
  envelope({ metadata: { phone_number_id: conn.phone_number_id }, contacts: [{ wa_id: PHONE, profile: { name: "Ali" } }], messages: [{ from: PHONE, id, timestamp: ts(T0), type: "text", text: { body }, ...extra }] });
const statusEvt = (wamid, status, at = T0, extra = {}) => envelope({ metadata: { phone_number_id: conn.phone_number_id }, statuses: [{ id: wamid, status, timestamp: ts(at), recipient_id: PHONE, ...extra }] });

describe("signature and body checks", () => {
  test("a bad signature is rejected before parsing", async () => {
    const [raw] = sign(inMsg("w1", "hi"));
    await assert.rejects(inbound.handle(raw, "sha256=" + "0".repeat(64)), { status: 401, code: "invalid_signature" });
    await assert.rejects(inbound.handle(raw, undefined), { status: 401 });
  });

  test("invalid JSON with a valid signature is a 400", async () => {
    const raw = Buffer.from("{not json");
    await assert.rejects(inbound.handle(raw, "sha256=" + createHmac("sha256", APP_SECRET).update(raw).digest("hex")), { status: 400 });
  });
});

describe("inbound messages", () => {
  test("creates contact, 24h window, conversation and message; notifies the tenant", async () => {
    const r = await deliver(inMsg("wamid.IN1", "Hello"));
    assert.deepEqual(r, { processed: 1, duplicates: 0, skipped: 0, ignored: 0 });
    const contact = await repo.getContactByPhone(t.db, tenant.id, PHONE);
    assert.equal(contact.name, "Ali");
    assert.equal(contact.source, "whatsapp");
    const w = await repo.getWindow(t.db, contact.id, conn.id);
    assert.deepEqual(w.expires_at, new Date(T0.getTime() + 24 * 3600_000));
    assert.equal(w.source, "user");
    const [m] = await repo.listMessages(t.db, tenant.id, {});
    assert.equal(m.direction, "inbound");
    assert.equal(m.status, "received");
    assert.deepEqual(m.content, { from: PHONE, sent_at: T0.toISOString(), body: "Hello" });
    assert.deepEqual(m.created_at, T0);
    assert.deepEqual(notifier.events.map((e) => [e.tenantId, e.type]), [[tenant.id, "message.received"]]);
  });

  test("a replayed delivery is processed once", async () => {
    await deliver(inMsg("wamid.IN1", "Hello"));
    const r = await deliver(inMsg("wamid.IN1", "Hello"));
    assert.equal(r.duplicates, 1);
    assert.equal((await repo.listMessages(t.db, tenant.id, {})).length, 1);
  });

  test("a Click-to-WhatsApp referral opens a 72h window", async () => {
    await deliver(inMsg("wamid.AD", "Hi from ad", { referral: { source_type: "ad", ctwa_clid: "c1" } }));
    const contact = await repo.getContactByPhone(t.db, tenant.id, PHONE);
    const w = await repo.getWindow(t.db, contact.id, conn.id);
    assert.equal(w.source, "ctwa");
    assert.deepEqual(w.expires_at, new Date(T0.getTime() + 72 * 3600_000));
  });

  test("after an inbound message the tenant can reply with free-form text", async () => {
    await deliver(inMsg("wamid.IN1", "Hello"));
    const { body } = await messaging.send({ tenant_id: tenant.id }, { to: PHONE, type: "text", text: { body: "Hi Ali" } });
    assert.equal(body.message.status, "sent");
    const convs = await repo.listConversations(t.db, tenant.id);
    assert.equal(convs.length, 1, "reply joins the same conversation");
  });

  test("STOP opts the contact out and START opts back in", async () => {
    await deliver(inMsg("w1", " stop! "));
    let contact = await repo.getContactByPhone(t.db, tenant.id, PHONE);
    assert.ok(contact.opted_out_at);
    assert.ok(notifier.events.some((e) => e.type === "contact.opted_out"));
    await assert.rejects(messaging.send({ tenant_id: tenant.id }, { to: PHONE, type: "text", text: { body: "x" } }), { code: "contact_opted_out" });
    await deliver(inMsg("w2", "START"));
    contact = await repo.getContactByPhone(t.db, tenant.id, PHONE);
    assert.equal(contact.opted_out_at, null);
    assert.ok(notifier.events.some((e) => e.type === "contact.opted_in"));
  });

  test("messages to an unknown number are skipped, not failed", async () => {
    const p = inMsg("w1", "hi");
    p.entry[0].changes[0].value.metadata.phone_number_id = "999999";
    assert.deepEqual(await deliver(p), { processed: 0, duplicates: 0, skipped: 1, ignored: 0 });
  });
});

describe("delivery statuses", () => {
  async function sendTemplate() {
    await seedTemplate(t.db, tenant.id, conn.waba_id);
    const { body } = await messaging.send({ tenant_id: tenant.id }, { to: PHONE, type: "template", template: { name: "order_update", language: "en", variables: { 1: "A", 2: "B" } } });
    return body.message;
  }

  test("statuses progress forward and stale ones are ignored", async () => {
    const m = await sendTemplate();
    const t1 = new Date(T0.getTime() + 1000);
    const t2 = new Date(T0.getTime() + 2000);
    await deliver(statusEvt(m.wamid, "read", t2));
    let row = await repo.getMessage(t.db, tenant.id, m.id);
    assert.equal(row.status, "read");
    assert.deepEqual(row.delivered_at, t2, "read implies delivered");
    const r = await deliver(statusEvt(m.wamid, "delivered", t1));
    assert.equal(r.skipped, 1);
    row = await repo.getMessage(t.db, tenant.id, m.id);
    assert.equal(row.status, "read");
  });

  test("a failed status refunds the credits exactly once", async () => {
    const m = await sendTemplate();
    assert.equal(await balanceOf(t.db, tenant.id), 90);
    await deliver(statusEvt(m.wamid, "failed", T0, { errors: [{ code: 131049, title: "Ecosystem engagement" }] }));
    const row = await repo.getMessage(t.db, tenant.id, m.id);
    assert.equal(row.status, "failed");
    assert.equal(row.error_code, "131049");
    assert.equal(await balanceOf(t.db, tenant.id), 100);
    await deliver(statusEvt(m.wamid, "failed", new Date(T0.getTime() + 1000), { errors: [{ code: 1 }] }));
    assert.equal(await balanceOf(t.db, tenant.id), 100);
  });

  test("failed after delivered is ignored and keeps the charge", async () => {
    const m = await sendTemplate();
    await deliver(statusEvt(m.wamid, "delivered"));
    await deliver(statusEvt(m.wamid, "failed", new Date(T0.getTime() + 1000)));
    assert.equal((await repo.getMessage(t.db, tenant.id, m.id)).status, "delivered");
    assert.equal(await balanceOf(t.db, tenant.id), 90);
  });
});

test("template review results update the stored template", async () => {
  await seedTemplate(t.db, tenant.id, conn.waba_id, { meta_id: "555", status: "pending" });
  await deliver(envelope({ event: "REJECTED", message_template_id: 555, message_template_name: "order_update", message_template_language: "en", reason: "INVALID_FORMAT" }, "message_template_status_update"));
  const [tpl] = await repo.listTemplates(t.db, tenant.id);
  assert.equal(tpl.status, "rejected");
  assert.equal(tpl.reject_reason, "INVALID_FORMAT");
  assert.ok(notifier.events.some((e) => e.type === "template.status" && e.data.status === "rejected"));
});

test("quality updates set the messaging tier and rating", async () => {
  await deliver(envelope({ display_phone_number: conn.display_phone, event: "FLAGGED", current_limit: "TIER_250" }, "phone_number_quality_update"));
  const c = await repo.getWabaConnection(t.db, tenant.id, conn.id);
  assert.equal(c.quality_rating, "RED");
  assert.equal(c.messaging_tier, "TIER_250");
});

test("keywordIntent", () => {
  assert.equal(keywordIntent("Stop"), "opt_out");
  assert.equal(keywordIntent("  unsubscribe. "), "opt_out");
  assert.equal(keywordIntent("please stop sending"), null);
  assert.equal(keywordIntent("start"), "opt_in");
  assert.equal(keywordIntent(undefined), null);
});

test("without META_APP_SECRET the webhook answers 503", async () => {
  const unconfigured = createInboundService({ db: t.db, appSecret: null });
  await assert.rejects(unconfigured.handle(Buffer.from("{}"), "sha256=x"), { status: 503, code: "whatsapp_not_configured" });
});
