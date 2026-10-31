import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import * as repo from "../../src/db/repo.js";
import { verifyTenantWebhook } from "../../src/lib/crypto.js";
import { createNotifier, presentMessage } from "../../src/services/notifier.js";
import { createTestDb } from "../helpers/db.js";
import { T0, makeClock, seedTenant } from "../helpers/fixtures.js";

let t;
before(async () => (t = await createTestDb()));
after(() => t.close());
beforeEach(() => t.reset());

function fakeFetch(statuses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const s = statuses.shift() ?? 200;
    if (s instanceof Error) throw s;
    return { status: s };
  };
  fn.calls = calls;
  return fn;
}

test("delivers signed events to matching active endpoints only", async () => {
  const tenant = await seedTenant(t.db);
  const all = await repo.insertWebhookEndpoint(t.db, { tenantId: tenant.id, url: "https://a.example/h", secret: "whsec_a", events: ["*"], now: T0 });
  await repo.insertWebhookEndpoint(t.db, { tenantId: tenant.id, url: "https://b.example/h", secret: "whsec_b", events: ["template.status"], now: T0 });
  const off = await repo.insertWebhookEndpoint(t.db, { tenantId: tenant.id, url: "https://c.example/h", secret: "whsec_c", events: ["*"], now: T0 });
  await repo.setWebhookEndpointActive(t.db, tenant.id, off.id, false);
  const fetch = fakeFetch([]);
  const clock = makeClock();
  const n = createNotifier({ db: t.db, fetch, now: clock, sleep: async () => {} });
  n.emit(tenant.id, "message.status", { id: "msg_1" });
  await n.drain();
  assert.equal(fetch.calls.length, 1);
  const { url, init } = fetch.calls[0];
  assert.equal(url, all.url);
  assert.equal(init.redirect, "manual");
  const body = JSON.parse(init.body);
  assert.equal(body.type, "message.status");
  assert.equal(body.tenant_id, tenant.id);
  assert.deepEqual(body.data, { id: "msg_1" });
  assert.ok(verifyTenantWebhook(init.body, init.headers["x-wa-signature"], "whsec_a", T0.getTime() / 1000));
});

test("retries on 5xx and network errors, not on 4xx; never throws", async () => {
  const tenant = await seedTenant(t.db);
  await repo.insertWebhookEndpoint(t.db, { tenantId: tenant.id, url: "https://a.example/h", secret: "s", events: ["*"], now: T0 });
  const logs = [];
  let fetch = fakeFetch([500, new Error("reset"), 200]);
  let n = createNotifier({ db: t.db, fetch, sleep: async () => {}, log: (l) => logs.push(l) });
  n.emit(tenant.id, "message.status", {});
  await n.drain();
  assert.equal(fetch.calls.length, 3);
  fetch = fakeFetch([400]);
  n = createNotifier({ db: t.db, fetch, sleep: async () => {}, log: (l) => logs.push(l) });
  n.emit(tenant.id, "message.status", {});
  await n.drain();
  assert.equal(fetch.calls.length, 1);
  assert.ok(logs.some((l) => l.status === 400));
  fetch = fakeFetch([500, 500, 500]);
  n = createNotifier({ db: t.db, fetch, sleep: async () => {}, log: (l) => logs.push(l) });
  n.emit(tenant.id, "message.status", {});
  await n.drain();
  assert.equal(fetch.calls.length, 3);
});

test("presentMessage hides the raw payload and formats dates", () => {
  const p = presentMessage({ id: "msg_1", direction: "outbound", content: { to: "1", body: "x", payload: { secret: 1 } }, created_at: T0, credits_held: 0 });
  assert.deepEqual(p.content, { to: "1", body: "x" });
  assert.equal(p.created_at, T0.toISOString());
  assert.equal(p.sent_at, null);
  assert.equal(presentMessage(null), null);
});
