import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createTemplateService, templateRowFromMeta } from "../../src/services/templates.js";
import { createTestDb } from "../helpers/db.js";
import { ENCRYPTION_KEY, fakeMeta, makeClock, metaError, seedConnection, seedTenant } from "../helpers/fixtures.js";

let t;
before(async () => (t = await createTestDb()));
after(() => t.close());
beforeEach(() => t.reset());

const metaTemplate = {
  id: "777",
  name: "welcome",
  language: "en_US",
  status: "APPROVED",
  category: "MARKETING",
  parameter_format: "NAMED",
  components: [{ type: "HEADER", format: "IMAGE" }, { type: "BODY", text: "Hi {{first_name}}" }],
};

test("templateRowFromMeta maps Cloud API fields", () => {
  assert.deepEqual(templateRowFromMeta(metaTemplate), {
    name: "welcome",
    language: "en_US",
    category: "marketing",
    status: "approved",
    components: metaTemplate.components,
    variables: ["first_name"],
    parameter_format: "named",
    header_format: "image",
    meta_id: "777",
    reject_reason: null,
  });
  assert.equal(templateRowFromMeta({ ...metaTemplate, parameter_format: undefined }).parameter_format, "positional");
  assert.equal(templateRowFromMeta({ ...metaTemplate, status: "REJECTED", rejected_reason: "SCAM" }).reject_reason, "SCAM");
  assert.equal(templateRowFromMeta({ ...metaTemplate, category: "UNKNOWN" }), null);
  assert.equal(templateRowFromMeta({ ...metaTemplate, name: "Bad Name" }), null);
  assert.equal(templateRowFromMeta({ ...metaTemplate, status: "WHATEVER" }), null);
});

test("sync upserts templates and updates them on re-sync", async () => {
  const tenant = await seedTenant(t.db);
  const conn = await seedConnection(t.db, tenant.id);
  const meta = fakeMeta();
  meta.templates = [metaTemplate, { ...metaTemplate, name: "Bad Name" }];
  const svc = createTemplateService({ db: t.db, meta, encryptionKey: ENCRYPTION_KEY, now: makeClock() });
  assert.deepEqual(await svc.sync(tenant.id, conn.id), { synced: 1, skipped: 1 });
  meta.templates = [{ ...metaTemplate, status: "PAUSED" }];
  await svc.sync(tenant.id, conn.id);
  const list = await svc.list(tenant.id);
  assert.equal(list.length, 1);
  assert.equal(list[0].status, "paused");
  assert.deepEqual(await svc.list(tenant.id, { status: "approved" }), []);
});

test("sync reports Meta errors and unknown numbers", async () => {
  const tenant = await seedTenant(t.db);
  const conn = await seedConnection(t.db, tenant.id);
  const meta = fakeMeta();
  meta.listTemplates = async () => {
    throw metaError("190", { message: "token expired" });
  };
  const svc = createTemplateService({ db: t.db, meta, encryptionKey: ENCRYPTION_KEY });
  await assert.rejects(svc.sync(tenant.id, conn.id), { status: 422, code: "meta_error" });
  await assert.rejects(svc.sync(tenant.id, "waba_missing"), { status: 404 });
});
