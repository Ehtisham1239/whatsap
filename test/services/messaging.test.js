import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import * as repo from "../../src/db/repo.js";
import { createInboundService } from "../../src/services/inbound.js";
import { createMessagingService } from "../../src/services/messaging.js";
import { createTestDb } from "../helpers/db.js";
import { createHmac } from "node:crypto";
import {
  APP_SECRET, ENCRYPTION_KEY, T0, balanceOf, fakeMeta, ledgerOf, makeClock, metaError, recordingNotifier,
  seedConnection, seedTemplate, seedTenant, seedWindow,
} from "../helpers/fixtures.js";

const PHONE = "923001234567";
let t;
before(async () => (t = await createTestDb()));
after(() => t.close());

let meta, clock, notifier, svc, tenant, conn, auth;
beforeEach(async () => {
  await t.reset();
  meta = fakeMeta();
  clock = makeClock();
  notifier = recordingNotifier();
  svc = createMessagingService({ db: t.db, meta, encryptionKey: ENCRYPTION_KEY, now: clock, notifier, sleep: async () => {} });
  tenant = await seedTenant(t.db, { balance: 100 });
  conn = await seedConnection(t.db, tenant.id);
  auth = { id: null, tenant_id: tenant.id, waba_connection_id: null };
});

const text = (body = "Hello") => ({ to: `+${PHONE}`, type: "text", text: { body } });
const tpl = (variables = { 1: "Ali", 2: "A-1" }, name = "order_update") => ({ to: PHONE, type: "template", template: { name, language: "en", variables } });
const messageCount = async () => Number((await t.db.query("select count(*)::int as n from messages")).rows[0].n);

describe("free-form messages", () => {
  test("inside the service window: sent free with the decrypted token", async () => {
    await seedWindow(t.db, tenant.id, conn.id, PHONE, new Date(T0.getTime() - 3600_000));
    const res = await svc.send(auth, text());
    assert.equal(res.status, 202);
    const m = res.body.message;
    assert.equal(m.status, "sent");
    assert.equal(m.wamid, "wamid.OUT1");
    assert.equal(m.category, "service");
    assert.equal(m.credits, 0);
    assert.equal(m.content.payload, undefined, "raw payload is not exposed");
    assert.equal(m.content.body, "Hello");
    assert.equal(meta.sends.length, 1);
    assert.equal(meta.sends[0].token, "EAAG-test-token");
    assert.equal(meta.sends[0].phoneNumberId, conn.phone_number_id);
    assert.deepEqual(meta.sends[0].payload, { to: PHONE, type: "text", text: { body: "Hello", preview_url: false } });
    assert.equal(await balanceOf(t.db, tenant.id), 100);
    assert.deepEqual(await ledgerOf(t.db, tenant.id), []);
    assert.deepEqual(notifier.events.map((e) => e.type), ["message.status"]);
  });

  test("outside the window: rejected with no message row, charge or API call", async () => {
    await seedWindow(t.db, tenant.id, conn.id, PHONE, new Date(T0.getTime() - 25 * 3600_000));
    await assert.rejects(svc.send(auth, text()), { status: 422, code: "outside_service_window" });
    assert.equal(await messageCount(), 0);
    assert.equal(meta.sends.length, 0);
  });

  test("a contact who never messaged cannot receive free-form text", async () => {
    await assert.rejects(svc.send(auth, text()), { code: "outside_service_window" });
  });

  test("invalid requests are rejected with field errors", async () => {
    await assert.rejects(svc.send(auth, { to: "12", type: "text" }), (e) => e.status === 400 && e.details.some((d) => d.field === "to"));
  });
});

describe("template messages and credits", () => {
  test("marketing template outside the window holds 10 credits", async () => {
    await seedTemplate(t.db, tenant.id, conn.waba_id);
    const { body } = await svc.send(auth, tpl());
    assert.equal(body.message.status, "sent");
    assert.equal(body.message.credits, 10);
    assert.equal(body.message.content.body, "Hi Ali, your order A-1 shipped.");
    assert.deepEqual(meta.sends[0].payload.template, { name: "order_update", language: { code: "en" }, components: [{ type: "body", parameters: [{ type: "text", text: "Ali" }, { type: "text", text: "A-1" }] }] });
    assert.equal(await balanceOf(t.db, tenant.id), 90);
    assert.deepEqual(await ledgerOf(t.db, tenant.id), [{ kind: "hold", amount: -10, balance_after: 90, message_id: body.message.id, note: null }]);
  });

  test("utility template inside the window is free", async () => {
    await seedTemplate(t.db, tenant.id, conn.waba_id, { category: "utility" });
    await seedWindow(t.db, tenant.id, conn.id, PHONE);
    const { body } = await svc.send(auth, tpl());
    assert.equal(body.message.credits, 0);
    assert.equal(await balanceOf(t.db, tenant.id), 100);
  });

  test("insufficient credits rolls everything back", async () => {
    await t.db.query("update wallets set balance = 5 where tenant_id = $1", [tenant.id]);
    await seedTemplate(t.db, tenant.id, conn.waba_id);
    await assert.rejects(svc.send(auth, tpl()), (e) => e.status === 402 && e.code === "insufficient_credits" && e.details.required === 10 && e.details.balance === 5);
    assert.equal(await messageCount(), 0);
    assert.equal(await balanceOf(t.db, tenant.id), 5);
    assert.equal(meta.sends.length, 0);
  });

  test("unknown, unapproved and mis-filled templates are rejected", async () => {
    await assert.rejects(svc.send(auth, tpl()), { code: "template_not_found" });
    await seedTemplate(t.db, tenant.id, conn.waba_id, { status: "paused" });
    await assert.rejects(svc.send(auth, tpl()), { code: "template_invalid" });
    await seedTemplate(t.db, tenant.id, conn.waba_id, { status: "approved" });
    await assert.rejects(svc.send(auth, tpl({ 1: "Ali" })), (e) => e.code === "template_invalid" && e.details.missing[0] === "2");
    assert.equal(await balanceOf(t.db, tenant.id), 100);
  });

  test("a permanent Cloud API error fails the message and refunds once", async () => {
    await seedTemplate(t.db, tenant.id, conn.waba_id);
    meta.respond(metaError("131026", { message: "Receiver incapable" }));
    const { body } = await svc.send(auth, tpl());
    assert.equal(body.message.status, "failed");
    assert.deepEqual(body.message.error, { code: "131026", message: "Receiver incapable" });
    assert.equal(body.message.credits_refunded, true);
    assert.equal(await balanceOf(t.db, tenant.id), 100);
    assert.deepEqual((await ledgerOf(t.db, tenant.id)).map((l) => [l.kind, l.amount, l.balance_after]), [["hold", -10, 90], ["refund", 10, 100]]);
  });

  test("a retryable error is retried, then succeeds", async () => {
    await seedWindow(t.db, tenant.id, conn.id, PHONE);
    meta.respond(metaError("130429", { retryable: true, status: 429 }), "wamid.OK");
    const { body } = await svc.send(auth, text());
    assert.equal(body.message.wamid, "wamid.OK");
    assert.equal(meta.sends.length, 2);
  });

  test("an ambiguous error stays queued, then the sweeper fails and refunds it", async () => {
    await seedTemplate(t.db, tenant.id, conn.waba_id);
    meta.respond(metaError("network_error", { retryable: true, ambiguous: true, status: 0 }));
    const { body } = await svc.send(auth, tpl());
    assert.equal(body.message.status, "queued");
    assert.equal(body.message.error.code, "network_error");
    assert.equal(meta.sends.length, 1, "ambiguous failures are not resent");
    assert.equal(await svc.sweepStuck(), 0, "too recent to sweep");
    clock.advance(11 * 60_000);
    assert.equal(await svc.sweepStuck(), 1);
    const m = await svc.get(auth, body.message.id);
    assert.equal(m.status, "failed");
    assert.equal(m.credits_refunded, true);
    assert.equal(await balanceOf(t.db, tenant.id), 100);
  });
});

describe("contacts, tenants and numbers", () => {
  test("opted-out and blocked contacts are refused", async () => {
    const c = await seedWindow(t.db, tenant.id, conn.id, PHONE);
    await repo.setContactOptOut(t.db, c.id, T0);
    await assert.rejects(svc.send(auth, text()), { code: "contact_opted_out" });
    await repo.setContactOptOut(t.db, c.id, null);
    await repo.setContactBlocked(t.db, tenant.id, PHONE, { at: T0, reason: "abuse" });
    await assert.rejects(svc.send(auth, text()), { code: "contact_blocked" });
  });

  test("suspended tenants cannot send", async () => {
    await repo.setTenantStatus(t.db, tenant.id, "suspended");
    await assert.rejects(svc.send(auth, text()), { status: 403, code: "tenant_not_active" });
  });

  test("a key bound to one number cannot send from another", async () => {
    const other = await seedConnection(t.db, tenant.id, { isDefault: false });
    const bound = { ...auth, waba_connection_id: conn.id };
    await assert.rejects(svc.send(bound, { ...text(), waba_connection_id: other.id }), { status: 403, code: "connection_not_allowed" });
  });

  test("another tenant's number is not found", async () => {
    const t2 = await seedTenant(t.db, { name: "Other" });
    const c2 = await seedConnection(t.db, t2.id);
    await assert.rejects(svc.send(auth, { ...text(), waba_connection_id: c2.id }), { status: 404 });
  });

  test("without a default number the caller must choose one", async () => {
    await t.db.query("update waba_connections set is_default = false");
    await assert.rejects(svc.send(auth, text()), { code: "no_default_number" });
  });

  test("a disconnected number cannot send", async () => {
    await repo.updateWabaConnection(t.db, conn.id, { status: "disconnected" });
    await assert.rejects(svc.send(auth, text()), { code: "number_not_connected" });
  });

  test("messages of another tenant are not visible", async () => {
    await seedWindow(t.db, tenant.id, conn.id, PHONE);
    const { body } = await svc.send(auth, text());
    const t2 = await seedTenant(t.db, { name: "Other" });
    await assert.rejects(svc.get({ tenant_id: t2.id }, body.message.id), { status: 404 });
    assert.equal((await svc.get(auth, body.message.id)).id, body.message.id);
  });
});

describe("idempotency", () => {
  test("the same key and body replays the first response without resending", async () => {
    await seedWindow(t.db, tenant.id, conn.id, PHONE);
    const a = await svc.send(auth, text(), "order-42");
    const b = await svc.send(auth, text(), "order-42");
    assert.equal(b.replayed, true);
    assert.equal(b.body.message.id, a.body.message.id);
    assert.equal(meta.sends.length, 1);
    assert.equal(await messageCount(), 1);
  });

  test("the same key with a different body is rejected", async () => {
    await seedWindow(t.db, tenant.id, conn.id, PHONE);
    await svc.send(auth, text("one"), "k1");
    await assert.rejects(svc.send(auth, text("two"), "k1"), { status: 422, code: "idempotency_key_reused" });
  });

  test("business errors are stored and replayed; keys are per tenant", async () => {
    await assert.rejects(svc.send(auth, text(), "k2"), { code: "outside_service_window" });
    const replay = await svc.send(auth, text(), "k2");
    assert.equal(replay.status, 422);
    assert.equal(replay.body.error.code, "outside_service_window");
    const t2 = await seedTenant(t.db, { name: "Other" });
    await seedConnection(t.db, t2.id);
    await assert.rejects(svc.send({ tenant_id: t2.id }, text(), "k2"), { code: "outside_service_window" });
  });

  test("an in-flight key returns 409", async () => {
    await repo.claimIdempotencyKey(t.db, { tenantId: tenant.id, key: "busy", requestHash: (await import("../../src/lib/crypto.js")).sha256Hex((await import("../../src/lib/crypto.js")).stableStringify(text())), now: T0 });
    await assert.rejects(svc.send(auth, text(), "busy"), { status: 409, code: "request_in_progress" });
  });

  test("unexpected errors release the key so the client can retry", async () => {
    await seedWindow(t.db, tenant.id, conn.id, PHONE);
    meta.respond(() => {
      throw new Error("boom");
    });
    await assert.rejects(svc.send(auth, text(), "k3"), /boom/);
    const r = await t.db.query("select * from idempotency_keys where key = 'k3'");
    assert.equal(r.rows.length, 0);
  });

  test("malformed keys are rejected", async () => {
    await assert.rejects(svc.send(auth, text(), "has space"), { status: 400 });
  });
});

describe("scheduling", () => {
  const at = new Date(T0.getTime() + 2 * 3600_000);

  test("scheduled messages hold credits and send when due", async () => {
    await seedTemplate(t.db, tenant.id, conn.waba_id);
    const { body } = await svc.send(auth, { ...tpl(), schedule_at: at.toISOString() });
    assert.equal(body.message.status, "scheduled");
    assert.equal(body.message.scheduled_for, at.toISOString());
    assert.equal(await balanceOf(t.db, tenant.id), 90);
    assert.equal(meta.sends.length, 0);
    assert.equal(await svc.runScheduled(), 0);
    clock.set(at);
    assert.equal(await svc.runScheduled(), 1);
    assert.equal((await svc.get(auth, body.message.id)).status, "sent");
    assert.equal(await svc.runScheduled(), 0, "never sent twice");
    assert.equal(meta.sends.length, 1);
  });

  test("free-form text may be scheduled only while the window will still be open", async () => {
    await seedWindow(t.db, tenant.id, conn.id, PHONE);
    assert.equal((await svc.send(auth, { ...text(), schedule_at: at.toISOString() })).body.message.status, "scheduled");
    await assert.rejects(svc.send(auth, { ...text(), schedule_at: new Date(T0.getTime() + 25 * 3600_000).toISOString() }), { code: "outside_service_window" });
  });

  test("cancelling a scheduled message refunds it; sent messages cannot be cancelled", async () => {
    await seedTemplate(t.db, tenant.id, conn.waba_id);
    const { body } = await svc.send(auth, { ...tpl(), schedule_at: at.toISOString() });
    const c = await svc.cancel(auth, body.message.id);
    assert.equal(c.status, "cancelled");
    assert.equal(await balanceOf(t.db, tenant.id), 100);
    await assert.rejects(svc.cancel(auth, body.message.id), { status: 409 });
    const sent = await svc.send(auth, tpl());
    await assert.rejects(svc.cancel(auth, sent.body.message.id), { code: "not_cancellable" });
    await assert.rejects(svc.cancel(auth, "msg_doesnotexist000000000"), { status: 404 });
  });
});

test("a delivery status that arrives before the wamid is stored is applied afterwards", async () => {
  const inbound = createInboundService({ db: t.db, appSecret: APP_SECRET, now: clock });
  await seedWindow(t.db, tenant.id, conn.id, PHONE);
  meta.respond(async () => {
    const payload = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{ id: "1001", changes: [{ field: "messages", value: { metadata: { phone_number_id: conn.phone_number_id }, statuses: [{ id: "wamid.RACE", status: "delivered", timestamp: String(T0.getTime() / 1000 + 5) }] } }] }],
    });
    const sig = "sha256=" + createHmac("sha256", APP_SECRET).update(payload).digest("hex");
    const r = await inbound.handle(Buffer.from(payload), sig);
    assert.equal(r.skipped, 1);
    return "wamid.RACE";
  });
  const { body } = await svc.send(auth, text());
  assert.equal(body.message.status, "delivered");
  assert.equal(body.message.delivered_at, new Date(T0.getTime() + 5000).toISOString());
});
