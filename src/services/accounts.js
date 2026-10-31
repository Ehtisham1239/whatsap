// Operator (admin) actions and API-key authentication.
import * as repo from "../db/repo.js";
import { encryptSecret, generateApiKey, generateWebhookSecret, hashApiKey, looksLikeApiKey } from "../lib/crypto.js";
import { AppError, badRequest, forbidden, notFound, unauthorized } from "../lib/errors.js";
import { ID_PREFIXES, newId } from "../lib/ids.js";
import { isHttpsUrl } from "../lib/templates.js";
import { MetaApiError } from "../meta/client.js";
import { EVENT_TYPES } from "./notifier.js";
import { changeBalance } from "./wallet.js";

export const TENANT_STATUSES = Object.freeze(["trial", "active", "pending_activation", "suspended", "cancelled"]);
const TOUCH_INTERVAL_MS = 60_000;

const str = (v, max) => typeof v === "string" && v.trim().length > 0 && v.length <= max;

/** Rejects URLs that point at loopback, private, link-local or metadata addresses. */
export function isPublicHttpsUrl(value) {
  if (!isHttpsUrl(value)) return false;
  const host = new URL(value).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) return false;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224) return false;
  }
  if (host.includes(":")) {
    if (host === "::1" || host === "::" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80") || host.startsWith("::ffff:")) return false;
  }
  return true;
}

export function createAccountService({ db, meta, encryptionKey, apiKeyPepper, now = () => new Date() }) {
  return {
    /** Resolves a bearer API key to { id, tenant_id, waba_connection_id, tenant_status }. */
    async authenticate(key) {
      if (!looksLikeApiKey(key)) throw unauthorized();
      const row = await repo.findActiveApiKeyByHash(db, hashApiKey(key, apiKeyPepper));
      if (!row) throw unauthorized();
      if (row.tenant_status === "cancelled") throw forbidden("tenant_cancelled", "This account is cancelled");
      const at = now();
      if (!row.last_used_at || at.getTime() - new Date(row.last_used_at).getTime() > TOUCH_INTERVAL_MS) await repo.touchApiKey(db, row.id, at);
      return row;
    },

    async createTenant({ name, status = "trial", timezone = "Asia/Karachi" } = {}) {
      if (!str(name, 200)) throw badRequest("name is required (max 200 characters)");
      if (!TENANT_STATUSES.includes(status)) throw badRequest(`status must be one of ${TENANT_STATUSES.join(", ")}`);
      if (!isValidTimeZone(timezone)) throw badRequest("timezone must be an IANA time zone such as Asia/Karachi");
      return db.tx((q) => repo.createTenant(q, { name: name.trim(), status, timezone, now: now() }));
    },

    async getTenant(id) {
      const t = await repo.getTenant(db, id);
      if (!t) throw notFound("Tenant not found");
      return { ...t, balance: await repo.getBalance(db, id) };
    },

    async setTenantStatus(id, status) {
      if (!TENANT_STATUSES.includes(status)) throw badRequest(`status must be one of ${TENANT_STATUSES.join(", ")}`);
      const t = await repo.setTenantStatus(db, id, status);
      if (!t) throw notFound("Tenant not found");
      return t;
    },

    /**
     * Connects a WhatsApp number. The access token is checked against the Cloud
     * API (phone number lookup) and stored encrypted; it is never returned.
     */
    async connectNumber(tenantId, { waba_id, phone_number_id, access_token, label, is_default } = {}) {
      if (!/^\d{5,25}$/.test(String(waba_id ?? ""))) throw badRequest("waba_id must be the numeric WhatsApp Business Account id");
      if (!/^\d{5,25}$/.test(String(phone_number_id ?? ""))) throw badRequest("phone_number_id must be the numeric phone number id");
      if (!str(access_token, 4096)) throw badRequest("access_token is required");
      if (label !== undefined && label !== null && !str(label, 100)) throw badRequest("label must be at most 100 characters");
      if (!(await repo.getTenant(db, tenantId))) throw notFound("Tenant not found");

      let info;
      try {
        info = await meta.getPhoneNumber({ phoneNumberId: String(phone_number_id), token: access_token });
      } catch (err) {
        if (err instanceof MetaApiError) throw new AppError(422, "meta_verification_failed", `WhatsApp rejected the number or token: ${err.message}`);
        throw err;
      }
      const id = newId(ID_PREFIXES.waba);
      try {
        return await db.tx(async (q) => {
          const makeDefault = is_default === true || !(await repo.getDefaultWabaConnection(q, tenantId));
          if (makeDefault) await q.query("update waba_connections set is_default = false where tenant_id = $1 and is_default", [tenantId]);
          const row = await repo.insertWabaConnection(q, {
            id,
            tenant_id: tenantId,
            waba_id: String(waba_id),
            phone_number_id: String(phone_number_id),
            display_phone: String(info?.display_phone_number || phone_number_id),
            label: label ?? info?.verified_name ?? null,
            token_cipher: encryptSecret(access_token, encryptionKey, id),
            is_default: makeDefault,
            status: "connected",
            quality_rating: info?.quality_rating ?? null,
            messaging_tier: info?.messaging_limit_tier ?? null,
            created_at: now(),
          });
          return presentConnection(row);
        });
      } catch (err) {
        if (err?.code === "23505") throw new AppError(409, "number_already_connected", "This phone number is already connected");
        throw err;
      }
    },

    async listNumbers(tenantId) {
      return (await repo.listWabaConnections(db, tenantId)).map(presentConnection);
    },

    async setNumberStatus(tenantId, id, status) {
      if (!["connected", "disconnected"].includes(status)) throw badRequest("status must be connected or disconnected");
      const conn = await repo.getWabaConnection(db, tenantId, id);
      if (!conn) throw notFound("WhatsApp number not found");
      return presentConnection(await repo.updateWabaConnection(db, id, { status }));
    },

    async setDefaultNumber(tenantId, id) {
      const row = await db.tx((q) => repo.setDefaultWabaConnection(q, tenantId, id));
      if (!row) throw notFound("WhatsApp number not found");
      return presentConnection(row);
    },

    /** Issues an API key. The plaintext key is returned only here. */
    async issueApiKey(tenantId, { name, waba_connection_id, environment = "live" } = {}) {
      if (!str(name, 100)) throw badRequest("name is required (max 100 characters)");
      if (!["live", "test"].includes(environment)) throw badRequest("environment must be live or test");
      if (!(await repo.getTenant(db, tenantId))) throw notFound("Tenant not found");
      if (waba_connection_id && !(await repo.getWabaConnection(db, tenantId, waba_connection_id))) throw notFound("WhatsApp number not found");
      const { key, prefix, hash } = generateApiKey(apiKeyPepper, { environment });
      const row = await repo.insertApiKey(db, { tenantId, name: name.trim(), prefix, hash, wabaConnectionId: waba_connection_id ?? null, now: now() });
      return { ...row, key };
    },

    listApiKeys: (tenantId) => repo.listApiKeys(db, tenantId),

    async revokeApiKey(tenantId, id) {
      const row = await repo.revokeApiKey(db, tenantId, id, now());
      if (!row) throw notFound("API key not found");
      return row;
    },

    async changeBalance(tenantId, { kind = "topup", amount, note } = {}) {
      const entry = await changeBalance(db, { tenantId, kind, amount, note, now: now() });
      return { entry, balance: entry.balance_after };
    },

    /** Registers a tenant webhook endpoint; the signing secret is returned only here. */
    async addWebhookEndpoint(tenantId, { url, events = ["*"] } = {}) {
      if (!isPublicHttpsUrl(url)) throw badRequest("url must be a public https URL");
      if (!Array.isArray(events) || !events.length || events.some((e) => e !== "*" && !EVENT_TYPES.includes(e))) throw badRequest(`events must be ["*"] or a list of: ${EVENT_TYPES.join(", ")}`);
      if (!(await repo.getTenant(db, tenantId))) throw notFound("Tenant not found");
      const secret = generateWebhookSecret();
      const row = await repo.insertWebhookEndpoint(db, { tenantId, url, secret, events: [...new Set(events)], now: now() });
      return { id: row.id, url: row.url, events: row.events, active: row.active, created_at: row.created_at, secret };
    },

    listWebhookEndpoints: (tenantId) => repo.listWebhookEndpoints(db, tenantId),

    async setWebhookEndpointActive(tenantId, id, active) {
      const row = await repo.setWebhookEndpointActive(db, tenantId, id, Boolean(active));
      if (!row) throw notFound("Webhook endpoint not found");
      return row;
    },
  };
}

export function presentConnection(c) {
  const { token_cipher, ...rest } = c;
  return rest;
}

export function isValidTimeZone(tz) {
  if (typeof tz !== "string" || !tz) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
