import { randomBytes } from "node:crypto";
import * as repo from "../../src/db/repo.js";
import { encryptSecret } from "../../src/lib/crypto.js";
import { ID_PREFIXES, newId } from "../../src/lib/ids.js";
import { MetaApiError } from "../../src/meta/client.js";

export const ENCRYPTION_KEY = randomBytes(32);
export const PEPPER = "test-pepper";
export const APP_SECRET = "test-app-secret";
export const T0 = new Date("2026-10-31T10:00:00Z");

/** A controllable clock: clock() returns the current time, clock.advance(ms) moves it. */
export function makeClock(start = T0) {
  let t = start.getTime();
  const clock = () => new Date(t);
  clock.advance = (ms) => (t += ms);
  clock.set = (d) => (t = new Date(d).getTime());
  return clock;
}

let phoneSeq = 100000;

export async function seedTenant(db, { name = "Acme", status = "active", balance = 0, now = T0 } = {}) {
  const tenant = await db.tx((q) => repo.createTenant(q, { name, status, now }));
  if (balance) await db.query("update wallets set balance = $2 where tenant_id = $1", [tenant.id, balance]);
  return tenant;
}

export async function seedConnection(db, tenantId, { token = "EAAG-test-token", isDefault = true, status = "connected", wabaId = "1001", now = T0 } = {}) {
  const id = newId(ID_PREFIXES.waba);
  const phoneNumberId = String(++phoneSeq);
  return repo.insertWabaConnection(db, {
    id,
    tenant_id: tenantId,
    waba_id: wabaId,
    phone_number_id: phoneNumberId,
    display_phone: `1555${phoneNumberId}`,
    token_cipher: encryptSecret(token, ENCRYPTION_KEY, id),
    is_default: isDefault,
    status,
    created_at: now,
  });
}

export async function seedTemplate(db, tenantId, wabaId, overrides = {}) {
  return repo.upsertTemplate(db, {
    tenant_id: tenantId,
    waba_id: wabaId,
    name: "order_update",
    language: "en",
    category: "marketing",
    status: "approved",
    parameter_format: "positional",
    header_format: "none",
    components: [{ type: "BODY", text: "Hi {{1}}, your order {{2}} shipped." }],
    variables: ["1", "2"],
    meta_id: "9001",
    now: T0,
    ...overrides,
  });
}

/** Opens a 24h service window as if the contact had messaged us at `at`. */
export async function seedWindow(db, tenantId, connId, phone, at = T0, source = "user") {
  const contact = await repo.upsertContact(db, { tenantId, phone, source: "whatsapp", now: at });
  const hours = source === "ctwa" ? 72 : 24;
  await repo.saveWindow(db, { tenantId, contactId: contact.id, wabaConnectionId: connId, window: { last_inbound_at: at, expires_at: new Date(at.getTime() + hours * 3600_000), source } });
  return contact;
}

/**
 * Fake Cloud API client. Queue outcomes with .respond(): a string wamid, a
 * MetaApiError, or a function (call) => wamid. Defaults to a fresh wamid.
 */
export function fakeMeta() {
  const outcomes = [];
  let seq = 0;
  const meta = {
    sends: [],
    phoneInfo: { display_phone_number: "+1 555 000 1111", verified_name: "Acme", quality_rating: "GREEN", messaging_limit_tier: "TIER_1K" },
    phoneError: null,
    templates: [],
    respond(...o) {
      outcomes.push(...o);
      return meta;
    },
    async sendMessage(call) {
      meta.sends.push(call);
      const o = outcomes.shift();
      if (o instanceof Error) throw o;
      if (typeof o === "function") return o(call);
      return o ?? `wamid.OUT${++seq}`;
    },
    async getPhoneNumber() {
      if (meta.phoneError) throw meta.phoneError;
      return meta.phoneInfo;
    },
    async listTemplates() {
      return meta.templates;
    },
    media: { info: { url: "https://lookaside.fbsbx.com/m/1", mime_type: "image/jpeg" }, body: Buffer.from("JPEGDATA"), contentType: "image/jpeg", error: null, calls: [] },
    async getMediaInfo(call) {
      meta.media.calls.push(call);
      if (meta.media.error) throw meta.media.error;
      return meta.media.info;
    },
    async downloadMedia(call) {
      meta.media.calls.push(call);
      return { body: meta.media.body, contentType: meta.media.contentType };
    },
  };
  return meta;
}

export const metaError = (code, { retryable = false, ambiguous = false, status = 400, message = "error" } = {}) => new MetaApiError({ status, code, message, retryable, ambiguous });

export function recordingNotifier() {
  const events = [];
  return { events, emit: (tenantId, type, data) => events.push({ tenantId, type, data }) };
}

export async function balanceOf(db, tenantId) {
  return repo.getBalance(db, tenantId);
}

export async function ledgerOf(db, tenantId) {
  return (await db.query("select kind, amount, balance_after, message_id, note from credit_ledger where tenant_id = $1 order by created_at, kind", [tenantId])).rows;
}
