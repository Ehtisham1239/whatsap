import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import * as repo from "../../src/db/repo.js";
import { createMediaService } from "../../src/services/media.js";
import { createTestDb } from "../helpers/db.js";
import { ENCRYPTION_KEY, T0, fakeMeta, metaError, seedConnection, seedTenant } from "../helpers/fixtures.js";

let t;
before(async () => (t = await createTestDb()));
after(() => t.close());

let meta, svc, tenant, conn;
beforeEach(async () => {
  await t.reset();
  meta = fakeMeta();
  svc = createMediaService({ db: t.db, meta, encryptionKey: ENCRYPTION_KEY });
  tenant = await seedTenant(t.db);
  conn = await seedConnection(t.db, tenant.id);
});

async function inboundMessage(content, direction = "inbound") {
  const contact = await repo.upsertContact(t.db, { tenantId: tenant.id, phone: "923001234567", now: T0 });
  const conv = await repo.getOrCreateConversation(t.db, { tenantId: tenant.id, contactId: contact.id, wabaConnectionId: conn.id, now: T0 });
  return repo.insertMessage(t.db, { tenant_id: tenant.id, conversation_id: conv.id, contact_id: contact.id, waba_connection_id: conn.id, direction, mode: "custom", type: "image", content, status: direction === "inbound" ? "received" : "sent", sent_via: "webhook", created_at: T0 });
}

test("downloads inbound media with the number's token", async () => {
  const m = await inboundMessage({ media_id: "777", mime_type: "image/jpeg", filename: "a.jpg" });
  const file = await svc.download({ tenant_id: tenant.id }, m.id);
  assert.equal(file.body.toString(), "JPEGDATA");
  assert.equal(file.contentType, "image/jpeg");
  assert.equal(file.filename, "a.jpg");
  assert.deepEqual(meta.media.calls[0], { mediaId: "777", token: "EAAG-test-token" });
});

test("unsafe content types are replaced", async () => {
  const m = await inboundMessage({ media_id: "777", mime_type: "text/html\r\nx: y" });
  assert.equal((await svc.download({ tenant_id: tenant.id }, m.id)).contentType, "application/octet-stream");
});

test("messages without media, outbound, other tenants and other bound numbers are 404", async () => {
  const text = await inboundMessage({ body: "hi" });
  await assert.rejects(svc.download({ tenant_id: tenant.id }, text.id), { status: 404 });
  const out = await inboundMessage({ media_id: "1" }, "outbound");
  await assert.rejects(svc.download({ tenant_id: tenant.id }, out.id), { status: 404 });
  const img = await inboundMessage({ media_id: "2" });
  const other = await seedTenant(t.db, { name: "Other" });
  await assert.rejects(svc.download({ tenant_id: other.id }, img.id), { status: 404 });
  await assert.rejects(svc.download({ tenant_id: tenant.id, waba_connection_id: "waba_other" }, img.id), { status: 404 });
});

test("expired media is 410; Meta outages are 502", async () => {
  const m = await inboundMessage({ media_id: "777" });
  meta.media.error = metaError("100", { status: 404 });
  await assert.rejects(svc.download({ tenant_id: tenant.id }, m.id), { status: 410, code: "media_unavailable" });
  meta.media.error = metaError("2", { status: 503, retryable: true });
  await assert.rejects(svc.download({ tenant_id: tenant.id }, m.id), { status: 502 });
});
