import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { createApp } from "../../src/http/app.js";
import { createAccountService } from "../../src/services/accounts.js";
import { createInboundService } from "../../src/services/inbound.js";
import { createMediaService } from "../../src/services/media.js";
import { createMessagingService } from "../../src/services/messaging.js";
import { createTemplateService } from "../../src/services/templates.js";
import { createTestDb } from "../helpers/db.js";
import { APP_SECRET, ENCRYPTION_KEY, PEPPER, fakeMeta, makeClock } from "../helpers/fixtures.js";

const ADMIN = "admin-token-admin-token-admin-token-1234";
const VERIFY = "verify-token-123456";
let t, server, base, meta, clock, logs;

before(async () => {
  t = await createTestDb();
  meta = fakeMeta();
  clock = makeClock();
  logs = [];
  const common = { db: t.db, meta, encryptionKey: ENCRYPTION_KEY, now: clock };
  const services = {
    db: t.db,
    accounts: createAccountService({ ...common, apiKeyPepper: PEPPER }),
    messaging: createMessagingService({ ...common, sleep: async () => {} }),
    inbound: createInboundService({ db: t.db, appSecret: APP_SECRET, now: clock }),
    templates: createTemplateService(common),
    media: createMediaService(common),
  };
  server = createServer(createApp(services, { adminToken: ADMIN, metaVerifyToken: VERIFY, rateLimit: { capacity: 1000, refillPerSecond: 1000 }, adminRateLimit: { capacity: 1000, refillPerSecond: 1000 } }, { log: (l) => logs.push(l), now: clock }));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((r) => server.close(r));
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  meta.sends.length = 0;
});

async function call(method, path, { token, body, headers = {}, raw } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined || raw ? { "content-type": "application/json" } : {}), ...headers },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text, headers: res.headers };
}
const adminCall = (m, p, body) => call(m, p, { token: ADMIN, body });

/** Creates tenant + number + API key + credits through the admin API. */
async function onboard({ credits = 100 } = {}) {
  const tenant = (await adminCall("POST", "/admin/tenants", { name: "Acme", status: "active" })).json.tenant;
  const number = (await adminCall("POST", `/admin/tenants/${tenant.id}/numbers`, { waba_id: "100200300", phone_number_id: "400500600", access_token: "EAAG-x" })).json.number;
  const key = (await adminCall("POST", `/admin/tenants/${tenant.id}/api-keys`, { name: "server" })).json.api_key.key;
  if (credits) await adminCall("POST", `/admin/tenants/${tenant.id}/balance`, { amount: credits });
  return { tenant, number, key };
}

function signed(payload) {
  const raw = JSON.stringify(payload);
  return { raw, headers: { "x-hub-signature-256": "sha256=" + createHmac("sha256", APP_SECRET).update(raw).digest("hex") } };
}

describe("health and routing", () => {
  test("health, security headers, 404 and 405", async () => {
    const h = await call("GET", "/health");
    assert.equal(h.status, 200);
    assert.equal(h.headers.get("x-content-type-options"), "nosniff");
    assert.equal(h.headers.get("cache-control"), "no-store");
    assert.ok(h.headers.get("x-request-id"));
    assert.equal((await call("GET", "/ready")).status, 200);
    assert.equal((await call("GET", "/nope")).status, 404);
    const m = await call("DELETE", "/health");
    assert.equal(m.status, 405);
    assert.equal(m.headers.get("allow"), "GET");
  });
});

describe("admin API", () => {
  test("requires the admin token", async () => {
    assert.equal((await call("POST", "/admin/tenants", { body: { name: "x" } })).status, 401);
    assert.equal((await call("POST", "/admin/tenants", { token: "wrong", body: { name: "x" } })).status, 401);
  });

  test("full onboarding flow; secrets never echoed after creation", async () => {
    const { tenant, number, key } = await onboard();
    assert.match(key, /^wa_live_/);
    assert.equal(number.token_cipher, undefined);
    const t2 = await adminCall("GET", `/admin/tenants/${tenant.id}`);
    assert.equal(t2.json.tenant.balance, 100);
    const keys = await adminCall("GET", `/admin/tenants/${tenant.id}/api-keys`);
    assert.ok(!keys.text.includes(key));
    assert.ok(!keys.text.includes('"hash"'));
    const numbers = await adminCall("GET", `/admin/tenants/${tenant.id}/numbers`);
    assert.ok(!numbers.text.includes("token_cipher"));
    const wh = await adminCall("POST", `/admin/tenants/${tenant.id}/webhook-endpoints`, { url: "https://hooks.example.com/wa" });
    assert.equal(wh.status, 201);
    assert.ok(wh.json.webhook_endpoint.secret);
    assert.ok(!(await adminCall("GET", `/admin/tenants/${tenant.id}/webhook-endpoints`)).text.includes(wh.json.webhook_endpoint.secret));
    assert.equal((await adminCall("PATCH", `/admin/tenants/${tenant.id}`, { status: "suspended" })).json.tenant.status, "suspended");
  });

  test("bad bodies are rejected", async () => {
    assert.equal((await call("POST", "/admin/tenants", { token: ADMIN, raw: "{bad" })).status, 400);
    assert.equal((await call("POST", "/admin/tenants", { token: ADMIN, raw: "[1]" })).status, 400);
    const r = await call("POST", "/admin/tenants", { token: ADMIN, raw: "name=x", headers: { "content-type": "text/plain" } });
    assert.equal(r.status, 415);
    const big = await call("POST", "/admin/tenants", { token: ADMIN, raw: JSON.stringify({ name: "x".repeat(1024 * 1024 + 10) }) });
    assert.equal(big.status, 413);
  });
});

describe("tenant API", () => {
  test("requires a valid API key", async () => {
    assert.equal((await call("GET", "/v1/messages")).status, 401);
    assert.equal((await call("GET", "/v1/messages", { token: "wa_live_" + "x".repeat(32) })).status, 401);
  });

  test("send a template, read it back, list it, and see the wallet", async () => {
    const { tenant, number, key } = await onboard();
    meta.templates = [{ id: "1", name: "order_update", language: "en", status: "APPROVED", category: "UTILITY", components: [{ type: "BODY", text: "Order {{1}} shipped" }] }];
    const sync = await call("POST", "/v1/templates/sync", { token: key, body: {} });
    assert.deepEqual(sync.json, { synced: 1, skipped: 0 });
    assert.equal((await call("GET", "/v1/templates", { token: key })).json.data[0].name, "order_update");

    const send = await call("POST", "/v1/messages", { token: key, headers: { "idempotency-key": "o-1" }, body: { to: "+923001234567", type: "template", template: { name: "order_update", language: "en", variables: { 1: "A-1" } } } });
    assert.equal(send.status, 202);
    const msg = send.json.message;
    assert.equal(msg.status, "sent");
    assert.equal(msg.credits, 4);
    assert.equal(msg.waba_connection_id, number.id);

    const replay = await call("POST", "/v1/messages", { token: key, headers: { "idempotency-key": "o-1" }, body: { to: "+923001234567", type: "template", template: { name: "order_update", language: "en", variables: { 1: "A-1" } } } });
    assert.equal(replay.headers.get("idempotent-replayed"), "true");
    assert.equal(replay.json.message.id, msg.id);

    assert.equal((await call("GET", `/v1/messages/${msg.id}`, { token: key })).json.message.id, msg.id);
    const list = await call("GET", "/v1/messages?limit=10", { token: key });
    assert.equal(list.json.data.length, 1);
    assert.equal(list.json.next_cursor, null);
    const wallet = await call("GET", "/v1/wallet", { token: key });
    assert.equal(wallet.json.balance, 96);
    assert.deepEqual(wallet.json.ledger.map((l) => l.kind).sort(), ["hold", "topup"]);
    assert.equal((await call("GET", "/v1/contacts", { token: key })).json.data[0].phone, "923001234567");
    assert.equal((await call("GET", "/v1/conversations", { token: key })).json.data.length, 1);
    assert.equal((await call("GET", "/v1/numbers", { token: key })).json.data[0].id, number.id);
    assert.ok(tenant.id);
  });

  test("errors carry stable codes", async () => {
    const { key } = await onboard();
    const r = await call("POST", "/v1/messages", { token: key, body: { to: "923001234567", type: "text", text: { body: "hi" } } });
    assert.equal(r.status, 422);
    assert.equal(r.json.error.code, "outside_service_window");
    const v = await call("POST", "/v1/messages", { token: key, body: { to: "x", type: "text" } });
    assert.equal(v.status, 400);
    assert.ok(Array.isArray(v.json.error.details));
    assert.equal((await call("GET", "/v1/messages?limit=500", { token: key })).status, 400);
    assert.equal((await call("GET", "/v1/messages?before=@@", { token: key })).status, 400);
    assert.equal((await call("GET", "/v1/messages/msg_unknown0000000000000", { token: key })).status, 404);
  });

  test("tenants cannot read each other's messages", async () => {
    const a = await onboard();
    await call("POST", "/v1/messages", { token: a.key, body: {} });
    const tenantB = (await adminCall("POST", "/admin/tenants", { name: "B", status: "active" })).json.tenant;
    const keyB = (await adminCall("POST", `/admin/tenants/${tenantB.id}/api-keys`, { name: "b" })).json.api_key.key;
    // seed a message for A via inbound webhook, then try to read it with B's key
    const p = signed({ object: "whatsapp_business_account", entry: [{ id: "100200300", changes: [{ field: "messages", value: { metadata: { phone_number_id: "400500600" }, messages: [{ from: "923001234567", id: "wamid.X", timestamp: "1761904800", type: "text", text: { body: "hi" } }] } }] }] });
    await call("POST", "/webhooks/meta", p);
    const [msg] = (await call("GET", "/v1/messages", { token: a.key })).json.data;
    assert.equal(msg.direction, "inbound");
    assert.equal((await call("GET", `/v1/messages/${msg.id}`, { token: keyB })).status, 404);
    assert.equal((await call("GET", "/v1/messages", { token: keyB })).json.data.length, 0);
  });

  test("block and unblock a contact; resolve a conversation", async () => {
    const { key } = await onboard();
    const p = signed({ object: "whatsapp_business_account", entry: [{ id: "100200300", changes: [{ field: "messages", value: { metadata: { phone_number_id: "400500600" }, messages: [{ from: "923001234567", id: "wamid.Y", timestamp: "1761904800", type: "text", text: { body: "hi" } }] } }] }] });
    await call("POST", "/webhooks/meta", p);
    const b = await call("POST", "/v1/contacts/+923001234567/block", { token: key, body: { blocked: true, reason: "spam" } });
    assert.equal(b.json.contact.blocked, true);
    const send = await call("POST", "/v1/messages", { token: key, body: { to: "923001234567", type: "text", text: { body: "x" } } });
    assert.equal(send.json.error.code, "contact_blocked");
    assert.equal((await call("POST", "/v1/contacts/923001234567/block", { token: key, body: { blocked: false } })).json.contact.blocked, false);
    assert.equal((await call("POST", "/v1/contacts/923009999999/block", { token: key, body: { blocked: true } })).status, 404);
    const [conv] = (await call("GET", "/v1/conversations", { token: key })).json.data;
    assert.equal((await call("POST", `/v1/conversations/${conv.id}/status`, { token: key, body: { status: "resolved" } })).json.conversation.status, "resolved");
    assert.equal((await call("POST", `/v1/conversations/${conv.id}/status`, { token: key, body: { status: "closed" } })).status, 400);
  });
});

describe("Meta webhook endpoints", () => {
  test("verification handshake", async () => {
    const ok = await call("GET", `/webhooks/meta?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=12345`);
    assert.equal(ok.status, 200);
    assert.equal(ok.text, "12345");
    assert.equal((await call("GET", `/webhooks/meta?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1`)).status, 403);
    assert.equal((await call("GET", `/webhooks/meta?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=<script>`)).status, 403);
  });

  test("unsigned or wrongly signed deliveries are rejected", async () => {
    assert.equal((await call("POST", "/webhooks/meta", { raw: "{}" })).status, 401);
    assert.equal((await call("POST", "/webhooks/meta", { raw: "{}", headers: { "x-hub-signature-256": "sha256=" + "a".repeat(64) } })).status, 401);
  });

  test("a signed delivery is acknowledged with a summary", async () => {
    const r = await call("POST", "/webhooks/meta", signed({ object: "whatsapp_business_account", entry: [] }));
    assert.equal(r.status, 200);
    assert.equal(r.json.received, true);
  });
});

test("unexpected errors return 500 with a request id and are logged", async () => {
  const failing = createServer(
    createApp({ db: { query: async () => { throw new Error("db down"); } } }, {}, { log: (l) => logs.push(l) }),
  );
  await new Promise((r) => failing.listen(0, "127.0.0.1", r));
  const res = await fetch(`http://127.0.0.1:${failing.address().port}/ready`);
  const body = await res.json();
  await new Promise((r) => failing.close(r));
  assert.equal(res.status, 500);
  assert.equal(body.error.code, "internal_error");
  assert.ok(!JSON.stringify(body).includes("db down"), "internal details are not leaked");
  assert.ok(logs.some((l) => l.msg === "unhandled error" && l.error === "db down"));
});

test("admin and API requests are rate limited with Retry-After", async () => {
  const limited = createServer(createApp({ db: t.db, accounts: { authenticate: async () => ({ id: "key_1", tenant_id: "ten_1" }) } }, { adminToken: ADMIN, adminRateLimit: { capacity: 2, refillPerSecond: 0.1 }, rateLimit: { capacity: 2, refillPerSecond: 0.1 } }));
  await new Promise((r) => limited.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${limited.address().port}`;
  const statuses = [];
  for (let i = 0; i < 3; i++) statuses.push((await fetch(`${url}/admin/tenants/x`, { headers: { authorization: "Bearer wrong" } })).status);
  assert.deepEqual(statuses, [401, 401, 429], "failed admin attempts are limited too");
  const api = [];
  let last;
  for (let i = 0; i < 3; i++) {
    last = await fetch(`${url}/v1/numbers`, { headers: { authorization: "Bearer wa_live_" + "a".repeat(32) } });
    api.push(last.status);
  }
  await new Promise((r) => limited.close(r));
  assert.equal(api[2], 429);
  assert.equal(last.headers.get("retry-after"), "10");
});

test("admin can switch the default number, disable endpoints and sync templates", async () => {
  const { tenant, number } = await onboard({ credits: 0 });
  const second = (await adminCall("POST", `/admin/tenants/${tenant.id}/numbers`, { waba_id: "100200300", phone_number_id: "400500601", access_token: "EAAG-y" })).json.number;
  assert.equal(second.is_default, false);
  assert.equal((await adminCall("PATCH", `/admin/tenants/${tenant.id}/numbers/${second.id}`, { is_default: true })).json.number.is_default, true);
  assert.equal((await adminCall("PATCH", `/admin/tenants/${tenant.id}/numbers/${number.id}`, { status: "disconnected" })).json.number.status, "disconnected");
  assert.equal((await adminCall("PATCH", `/admin/tenants/${tenant.id}/numbers/${number.id}`, {})).status, 400);
  const wh = (await adminCall("POST", `/admin/tenants/${tenant.id}/webhook-endpoints`, { url: "https://hooks.example.com/x" })).json.webhook_endpoint;
  assert.equal((await adminCall("PATCH", `/admin/tenants/${tenant.id}/webhook-endpoints/${wh.id}`, { active: false })).json.webhook_endpoint.active, false);
  meta.templates = [];
  assert.deepEqual((await adminCall("POST", `/admin/tenants/${tenant.id}/templates/sync`, { waba_connection_id: second.id })).json, { synced: 0, skipped: 0 });
  assert.equal((await adminCall("POST", `/admin/tenants/${tenant.id}/templates/sync`, {})).status, 400);
  const keyId = (await adminCall("POST", `/admin/tenants/${tenant.id}/api-keys`, { name: "tmp" })).json.api_key.id;
  assert.ok((await adminCall("DELETE", `/admin/tenants/${tenant.id}/api-keys/${keyId}`)).json.api_key.revoked_at);
});

test("a key bound to one number only sees and syncs that number", async () => {
  const { tenant, number } = await onboard({ credits: 0 });
  const other = (await adminCall("POST", `/admin/tenants/${tenant.id}/numbers`, { waba_id: "100200300", phone_number_id: "400500602", access_token: "EAAG-z" })).json.number;
  const key = (await adminCall("POST", `/admin/tenants/${tenant.id}/api-keys`, { name: "bound", waba_connection_id: number.id })).json.api_key.key;
  assert.deepEqual((await call("GET", "/v1/numbers", { token: key })).json.data.map((n) => n.id), [number.id]);
  assert.equal((await call("POST", "/v1/templates/sync", { token: key, body: { waba_connection_id: other.id } })).status, 403);
});

test("inbound media downloads as an attachment with a safe file name", async () => {
  const { key } = await onboard({ credits: 0 });
  const p = signed({ object: "whatsapp_business_account", entry: [{ id: "100200300", changes: [{ field: "messages", value: { metadata: { phone_number_id: "400500600" }, messages: [{ from: "923001234567", id: "wamid.DOC", timestamp: "1761904800", type: "document", document: { id: "555", mime_type: "application/pdf", filename: "../in voice.pdf" } }] } }] }] });
  await call("POST", "/webhooks/meta", p);
  const [msg] = (await call("GET", "/v1/messages", { token: key })).json.data;
  const res = await fetch(`${base}/v1/messages/${msg.id}/media`, { headers: { authorization: `Bearer ${key}` } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/pdf");
  assert.equal(res.headers.get("content-disposition"), 'attachment; filename=".._in_voice.pdf"');
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(Buffer.from(await res.arrayBuffer()).toString(), "JPEGDATA");
});
