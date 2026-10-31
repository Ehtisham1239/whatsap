import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import * as repo from "../../src/db/repo.js";
import { decryptSecret, hashApiKey } from "../../src/lib/crypto.js";
import { createAccountService, isPublicHttpsUrl, isValidTimeZone } from "../../src/services/accounts.js";
import { createTestDb } from "../helpers/db.js";
import { ENCRYPTION_KEY, PEPPER, T0, fakeMeta, ledgerOf, makeClock, metaError, seedConnection, seedTenant } from "../helpers/fixtures.js";

let t;
before(async () => (t = await createTestDb()));
after(() => t.close());

let meta, clock, svc;
beforeEach(async () => {
  await t.reset();
  meta = fakeMeta();
  clock = makeClock();
  svc = createAccountService({ db: t.db, meta, encryptionKey: ENCRYPTION_KEY, apiKeyPepper: PEPPER, now: clock });
});

describe("tenants", () => {
  test("createTenant creates an empty wallet and validates input", async () => {
    const tenant = await svc.createTenant({ name: " Acme " });
    assert.equal(tenant.name, "Acme");
    assert.equal(tenant.status, "trial");
    assert.equal((await svc.getTenant(tenant.id)).balance, 0);
    await assert.rejects(svc.createTenant({ name: "" }), { status: 400 });
    await assert.rejects(svc.createTenant({ name: "x", status: "vip" }), { status: 400 });
    await assert.rejects(svc.createTenant({ name: "x", timezone: "Mars/Base" }), { status: 400 });
    await assert.rejects(svc.getTenant("ten_missing"), { status: 404 });
  });

  test("setTenantStatus", async () => {
    const tenant = await svc.createTenant({ name: "Acme" });
    assert.equal((await svc.setTenantStatus(tenant.id, "suspended")).status, "suspended");
    await assert.rejects(svc.setTenantStatus(tenant.id, "nope"), { status: 400 });
    await assert.rejects(svc.setTenantStatus("ten_x", "active"), { status: 404 });
  });
});

describe("API keys", () => {
  test("issued key authenticates; only the hash is stored", async () => {
    const tenant = await seedTenant(t.db);
    const issued = await svc.issueApiKey(tenant.id, { name: "server" });
    assert.match(issued.key, /^wa_live_/);
    const stored = (await t.db.query("select hash from api_keys where id = $1", [issued.id])).rows[0];
    assert.equal(stored.hash, hashApiKey(issued.key, PEPPER));
    assert.ok(!JSON.stringify(await svc.listApiKeys(tenant.id)).includes(stored.hash));
    const auth = await svc.authenticate(issued.key);
    assert.equal(auth.tenant_id, tenant.id);
    assert.equal(auth.id, issued.id);
  });

  test("malformed, unknown and revoked keys are unauthorized", async () => {
    const tenant = await seedTenant(t.db);
    const issued = await svc.issueApiKey(tenant.id, { name: "server" });
    await assert.rejects(svc.authenticate("nope"), { status: 401 });
    await assert.rejects(svc.authenticate("wa_live_" + "A".repeat(32)), { status: 401 });
    await svc.revokeApiKey(tenant.id, issued.id);
    await assert.rejects(svc.authenticate(issued.key), { status: 401 });
    await assert.rejects(svc.revokeApiKey(tenant.id, "key_missing"), { status: 404 });
  });

  test("a different pepper cannot verify keys", async () => {
    const tenant = await seedTenant(t.db);
    const issued = await svc.issueApiKey(tenant.id, { name: "server" });
    const other = createAccountService({ db: t.db, meta, encryptionKey: ENCRYPTION_KEY, apiKeyPepper: "other" });
    await assert.rejects(other.authenticate(issued.key), { status: 401 });
  });

  test("cancelled tenants are forbidden", async () => {
    const tenant = await seedTenant(t.db, { status: "cancelled" });
    const issued = await svc.issueApiKey(tenant.id, { name: "server" });
    await assert.rejects(svc.authenticate(issued.key), { status: 403, code: "tenant_cancelled" });
  });

  test("last_used_at is written at most once a minute", async () => {
    const tenant = await seedTenant(t.db);
    const issued = await svc.issueApiKey(tenant.id, { name: "server" });
    await svc.authenticate(issued.key);
    clock.advance(30_000);
    await svc.authenticate(issued.key);
    let row = (await t.db.query("select last_used_at from api_keys where id = $1", [issued.id])).rows[0];
    assert.deepEqual(row.last_used_at, T0);
    clock.advance(31_000);
    await svc.authenticate(issued.key);
    row = (await t.db.query("select last_used_at from api_keys where id = $1", [issued.id])).rows[0];
    assert.deepEqual(row.last_used_at, new Date(T0.getTime() + 61_000));
  });

  test("a key can be bound only to the tenant's own number", async () => {
    const tenant = await seedTenant(t.db);
    const other = await seedTenant(t.db, { name: "Other" });
    const otherConn = await seedConnection(t.db, other.id);
    await assert.rejects(svc.issueApiKey(tenant.id, { name: "k", waba_connection_id: otherConn.id }), { status: 404 });
    await assert.rejects(svc.issueApiKey(tenant.id, { name: "" }), { status: 400 });
  });
});

describe("WhatsApp numbers", () => {
  const input = { waba_id: "100200300", phone_number_id: "400500600", access_token: "EAAG-secret" };

  test("connectNumber verifies with Meta, encrypts the token and hides it", async () => {
    const tenant = await seedTenant(t.db);
    const c = await svc.connectNumber(tenant.id, input);
    assert.equal(c.token_cipher, undefined);
    assert.equal(c.is_default, true, "first number becomes default");
    assert.equal(c.display_phone, "+1 555 000 1111");
    assert.equal(c.messaging_tier, "TIER_1K");
    const row = (await t.db.query("select token_cipher from waba_connections where id = $1", [c.id])).rows[0];
    assert.ok(!row.token_cipher.includes("EAAG"));
    assert.equal(decryptSecret(row.token_cipher, ENCRYPTION_KEY, c.id), "EAAG-secret");
  });

  test("a second number is not default unless asked; setDefaultNumber switches", async () => {
    const tenant = await seedTenant(t.db);
    const a = await svc.connectNumber(tenant.id, input);
    const b = await svc.connectNumber(tenant.id, { ...input, phone_number_id: "400500601" });
    assert.equal(b.is_default, false);
    await svc.setDefaultNumber(tenant.id, b.id);
    const list = await svc.listNumbers(tenant.id);
    assert.deepEqual(list.map((c) => [c.id, c.is_default]), [[a.id, false], [b.id, true]]);
  });

  test("duplicates, bad ids and Meta rejections are reported", async () => {
    const tenant = await seedTenant(t.db);
    await svc.connectNumber(tenant.id, input);
    await assert.rejects(svc.connectNumber(tenant.id, input), { status: 409, code: "number_already_connected" });
    await assert.rejects(svc.connectNumber(tenant.id, { ...input, waba_id: "abc" }), { status: 400 });
    await assert.rejects(svc.connectNumber(tenant.id, { ...input, access_token: "" }), { status: 400 });
    meta.phoneError = metaError("190", { message: "Invalid OAuth access token" });
    await assert.rejects(svc.connectNumber(tenant.id, { ...input, phone_number_id: "700800900" }), { status: 422, code: "meta_verification_failed" });
    await assert.rejects(svc.connectNumber("ten_missing", { ...input, phone_number_id: "700800901" }), { status: 404 });
  });

  test("setNumberStatus", async () => {
    const tenant = await seedTenant(t.db);
    const c = await svc.connectNumber(tenant.id, input);
    assert.equal((await svc.setNumberStatus(tenant.id, c.id, "disconnected")).status, "disconnected");
    await assert.rejects(svc.setNumberStatus(tenant.id, c.id, "pending"), { status: 400 });
  });
});

describe("wallet", () => {
  test("top-ups and adjustments are ledgered", async () => {
    const tenant = await seedTenant(t.db);
    assert.equal((await svc.changeBalance(tenant.id, { amount: 500 })).balance, 500);
    assert.equal((await svc.changeBalance(tenant.id, { kind: "adjustment", amount: -50, note: "correction" })).balance, 450);
    assert.deepEqual((await ledgerOf(t.db, tenant.id)).map((l) => [l.kind, l.amount, l.balance_after]).sort(), [["adjustment", -50, 450], ["topup", 500, 500]]);
  });

  test("invalid amounts and overdrafts are refused", async () => {
    const tenant = await seedTenant(t.db, { balance: 10 });
    await assert.rejects(svc.changeBalance(tenant.id, { amount: 0 }), { status: 400 });
    await assert.rejects(svc.changeBalance(tenant.id, { amount: 1.5 }), { status: 400 });
    await assert.rejects(svc.changeBalance(tenant.id, { amount: -5 }), { status: 400 });
    await assert.rejects(svc.changeBalance(tenant.id, { kind: "adjustment", amount: -5 }), { status: 400 });
    await assert.rejects(svc.changeBalance(tenant.id, { kind: "adjustment", amount: -11, note: "x" }), { status: 402 });
    await assert.rejects(svc.changeBalance("ten_missing", { amount: 5 }), { status: 404 });
    assert.equal((await svc.getTenant(tenant.id)).balance, 10);
  });

  test("the ledger is append-only in the database", async () => {
    const tenant = await seedTenant(t.db);
    await svc.changeBalance(tenant.id, { amount: 5 });
    await assert.rejects(t.db.query("update credit_ledger set amount = 1"), /append-only/);
    await assert.rejects(t.db.query("delete from credit_ledger"), /append-only/);
  });

  test("the wallet balance can never go negative", async () => {
    const tenant = await seedTenant(t.db);
    await assert.rejects(t.db.query("update wallets set balance = -1 where tenant_id = $1", [tenant.id]), /wallets_balance_check/);
  });
});

describe("webhook endpoints", () => {
  test("secret is returned once and events are validated", async () => {
    const tenant = await seedTenant(t.db);
    const e = await svc.addWebhookEndpoint(tenant.id, { url: "https://hooks.example.com/wa", events: ["message.status", "message.status"] });
    assert.match(e.secret, /^whsec_/);
    assert.deepEqual(e.events, ["message.status"]);
    assert.ok(!JSON.stringify(await svc.listWebhookEndpoints(tenant.id)).includes(e.secret));
    await assert.rejects(svc.addWebhookEndpoint(tenant.id, { url: "https://hooks.example.com", events: ["bogus"] }), { status: 400 });
    assert.equal((await svc.setWebhookEndpointActive(tenant.id, e.id, false)).active, false);
  });

  test("isPublicHttpsUrl blocks internal targets", () => {
    for (const u of ["https://example.com/x", "https://8.8.8.8/hook"]) assert.ok(isPublicHttpsUrl(u), u);
    for (const u of [
      "http://example.com", "https://localhost/x", "https://api.localhost", "https://127.0.0.1", "https://10.1.2.3", "https://172.20.0.1",
      "https://192.168.1.1", "https://169.254.169.254/latest", "https://100.64.0.1", "https://[::1]/", "https://[fd00::1]/", "https://[::ffff:127.0.0.1]/",
      "https://metadata.google.internal", "https://0.0.0.0", "notaurl",
    ]) {
      assert.ok(!isPublicHttpsUrl(u), u);
    }
  });
});

test("isValidTimeZone", () => {
  assert.ok(isValidTimeZone("Asia/Karachi"));
  assert.ok(!isValidTimeZone(""));
  assert.ok(!isValidTimeZone("Nowhere/City"));
});

test("repo: contacts are unique per tenant phone and keep the first name", async () => {
  const tenant = await seedTenant(t.db);
  const a = await repo.upsertContact(t.db, { tenantId: tenant.id, phone: "923001234567", name: "Ali", now: T0 });
  const b = await repo.upsertContact(t.db, { tenantId: tenant.id, phone: "923001234567", name: "Other", now: T0 });
  assert.equal(a.id, b.id);
  assert.equal(b.name, "Ali");
  await assert.rejects(repo.upsertContact(t.db, { tenantId: tenant.id, phone: "+92300", now: T0 }), /contacts_phone_check/);
});
