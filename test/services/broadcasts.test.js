import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import * as repo from "../../src/db/repo.js";
import { createBroadcastService, validateBroadcastRequest } from "../../src/services/broadcasts.js";
import { createMessagingService } from "../../src/services/messaging.js";
import { createTestDb } from "../helpers/db.js";
import { ENCRYPTION_KEY, T0, balanceOf, fakeMeta, makeClock, metaError, seedConnection, seedTemplate, seedTenant, seedWindow } from "../helpers/fixtures.js";

let t;
before(async () => (t = await createTestDb()));
after(() => t.close());

let meta, clock, messaging, svc, tenant, conn, auth;
beforeEach(async () => {
  await t.reset();
  meta = fakeMeta();
  clock = makeClock();
  messaging = createMessagingService({ db: t.db, meta, encryptionKey: ENCRYPTION_KEY, now: clock, sleep: async () => {} });
  svc = createBroadcastService({ db: t.db, messaging, now: clock });
  tenant = await seedTenant(t.db, { balance: 100 });
  conn = await seedConnection(t.db, tenant.id);
  await seedTemplate(t.db, tenant.id, conn.waba_id);
  auth = { id: null, user_id: "usr_x", tenant_id: tenant.id, waba_connection_id: null };
});

const body = (recipients, extra = {}) => ({ name: "Diwali offer", template: { name: "order_update", language: "en" }, recipients, ...extra });
const r = (to, a = "Ali", b = "A-1") => ({ to, variables: { 1: a, 2: b } });

describe("validateBroadcastRequest", () => {
  test("normalises numbers, drops duplicates and reports bad rows", () => {
    const { value } = validateBroadcastRequest(body([r("+92 300 1111111"), r("923001111111"), r("0300 2222222")]), { defaultCountryCode: "92" });
    assert.deepEqual(value.recipients.map((x) => x.to), ["923001111111", "923002222222"]);
    assert.equal(value.duplicates, 1);
    assert.throws(() => validateBroadcastRequest(body([r("123"), { to: "923001111111", variables: [] }])), (e) => e.status === 400 && e.details.length === 2 && e.details[0].field === "recipients[0].to");
    assert.throws(() => validateBroadcastRequest({ ...body([]), name: "" }), (e) => e.details.some((d) => d.field === "name") && e.details.some((d) => d.field === "recipients"));
    assert.throws(() => validateBroadcastRequest(body(Array.from({ length: 5001 }, () => r("923001111111")))), /Broadcast validation failed/);
    assert.throws(() => validateBroadcastRequest(body([r("923001111111")], { schedule_at: "2026-11-01T10:00:00" })), (e) => e.details[0].field === "schedule_at");
  });
});

describe("create and dispatch", () => {
  test("holds credits for every recipient and sends them all", async () => {
    const b = await svc.create(auth, body([r("923001111111"), r("923002222222", "Sara", "B-2")]));
    assert.equal(b.total, 2);
    assert.equal(b.credits, 20);
    assert.equal(await balanceOf(t.db, tenant.id), 80);
    await svc.drain();
    const done = await svc.get(auth, b.id);
    assert.equal(done.state, "completed");
    assert.equal(done.counts.sent, 2);
    assert.equal(meta.sends.length, 2);
    assert.deepEqual(meta.sends.map((s) => s.payload.template.components[0].parameters[0].text).sort(), ["Ali", "Sara"]);
    const [m] = await repo.listMessages(t.db, tenant.id, { limit: 1 });
    assert.equal(m.broadcast_id, b.id);
    assert.equal(m.sent_via, "broadcast");
  });

  test("one invalid row rejects the whole broadcast with no charge", async () => {
    await assert.rejects(svc.create(auth, body([r("923001111111"), { to: "923002222222", variables: { 1: "x" } }])), (e) => e.status === 422 && e.code === "template_invalid" && e.details[0].message.includes("923002222222"));
    assert.equal(await balanceOf(t.db, tenant.id), 100);
    assert.equal((await svc.list(auth)).length, 0);
  });

  test("not enough credits rejects the whole broadcast", async () => {
    const many = Array.from({ length: 11 }, (_, i) => r(`9230011111${String(i).padStart(2, "0")}`));
    await assert.rejects(svc.create(auth, body(many)), (e) => e.status === 402 && e.details.required === 110 && e.details.balance === 100);
    assert.equal(await balanceOf(t.db, tenant.id), 100);
    assert.equal(Number((await t.db.query("select count(*) from messages")).rows[0].count), 0);
  });

  test("opted-out and blocked contacts are skipped and not charged", async () => {
    const c = await repo.upsertContact(t.db, { tenantId: tenant.id, phone: "923001111111", now: T0 });
    await repo.setContactOptOut(t.db, c.id, T0);
    await repo.upsertContact(t.db, { tenantId: tenant.id, phone: "923003333333", now: T0 });
    await repo.setContactBlocked(t.db, tenant.id, "923003333333", { at: T0, reason: "x" });
    const b = await svc.create(auth, body([r("923001111111"), r("923002222222"), r("923003333333"), r("923002222222")]));
    assert.equal(b.total, 1);
    assert.equal(b.skipped, 3, "opted out + blocked + duplicate");
    assert.equal(b.credits, 10);
    await assert.rejects(svc.create(auth, body([r("923001111111")])), { code: "no_recipients" });
  });

  test("utility templates are free for contacts inside their service window", async () => {
    await seedTemplate(t.db, tenant.id, conn.waba_id, { name: "receipt", category: "utility" });
    await seedWindow(t.db, tenant.id, conn.id, "923001111111");
    const b = await svc.create(auth, { ...body([r("923001111111"), r("923002222222")]), template: { name: "receipt", language: "en" } });
    assert.equal(b.credits, 4);
  });

  test("Meta failures during sending are refunded per message", async () => {
    meta.respond("wamid.A", metaError("131026", { message: "undeliverable" }));
    const b = await svc.create(auth, body([r("923001111111"), r("923002222222")]));
    await svc.drain();
    const done = await svc.get(auth, b.id);
    assert.deepEqual([done.counts.sent, done.counts.failed], [1, 1]);
    assert.equal(await balanceOf(t.db, tenant.id), 90);
  });

  test("tenant checks: suspended, unknown number, missing template, other tenant", async () => {
    await assert.rejects(svc.create(auth, { ...body([r("923001111111")]), template: { name: "nope", language: "en" } }), { code: "template_not_found" });
    await assert.rejects(svc.create(auth, body([r("923001111111")], { waba_connection_id: "waba_missing" })), { status: 404 });
    await assert.rejects(svc.create({ ...auth, waba_connection_id: conn.id }, body([r("923001111111")], { waba_connection_id: "waba_other" })), { code: "connection_not_allowed" });
    const b = await svc.create(auth, body([r("923001111111")], { schedule_at: new Date(T0.getTime() + 3600_000).toISOString() }));
    const other = await seedTenant(t.db, { name: "Other" });
    await assert.rejects(svc.get({ tenant_id: other.id }, b.id), { status: 404 });
    await assert.rejects(svc.cancel({ tenant_id: other.id }, b.id), { status: 404 });
    await repo.setTenantStatus(t.db, tenant.id, "suspended");
    await assert.rejects(svc.create(auth, body([r("923001111111")])), { code: "tenant_not_active" });
  });
});

describe("scheduling and cancelling", () => {
  test("a scheduled broadcast waits, then the scheduler sends it", async () => {
    const at = new Date(T0.getTime() + 2 * 3600_000);
    const b = await svc.create(auth, body([r("923001111111")], { schedule_at: at.toISOString() }));
    assert.equal(b.state, "scheduled");
    await svc.drain();
    assert.equal(meta.sends.length, 0);
    clock.set(at);
    await messaging.runScheduled();
    assert.equal((await svc.get(auth, b.id)).state, "completed");
  });

  test("cancelling refunds unsent messages only", async () => {
    const at = new Date(T0.getTime() + 3600_000);
    const b = await svc.create(auth, body([r("923001111111"), r("923002222222")], { schedule_at: at.toISOString() }));
    assert.equal(await balanceOf(t.db, tenant.id), 80);
    const c = await svc.cancel(auth, b.id);
    assert.equal(c.state, "cancelled");
    assert.equal(c.counts.cancelled, 2);
    assert.equal(await balanceOf(t.db, tenant.id), 100);
    await assert.rejects(svc.cancel(auth, b.id), { status: 409 });
    clock.set(at);
    assert.equal(await messaging.runScheduled(), 0, "cancelled messages are never sent");
  });
});

test("regression: the stuck sweeper ignores a scheduled message that was just queued", async () => {
  const at = new Date(T0.getTime() + 3 * 3600_000);
  await svc.create(auth, body([r("923001111111")], { schedule_at: at.toISOString() }));
  clock.set(at);
  // Claimed hours after it was created: queued_at, not created_at, decides staleness.
  await t.db.tx((q) => repo.claimDueScheduled(q, clock()));
  assert.equal(await messaging.sweepStuck(), 0);
  clock.advance(11 * 60_000);
  assert.equal(await messaging.sweepStuck(), 1);
});
