// Broadcasts: one approved template sent to many contacts. Creation is all or
// nothing: every row is validated and the whole cost is held up front, then the
// messages are queued as scheduled sends that the scheduler dispatches.
import * as repo from "../db/repo.js";
import { badRequest, conflict, forbidden, notFound, unprocessable } from "../lib/errors.js";
import { normalizePhone } from "../lib/phone.js";
import { DEFAULT_PRICES, priceOutbound } from "../lib/pricing.js";
import { buildTemplatePayload, isHttpsUrl, isValidTemplateName, renderTemplateText, TemplateError } from "../lib/templates.js";
import { buildOutboundPayload } from "../meta/client.js";
import { holdCredits, InsufficientCreditsError, refundMessage } from "./wallet.js";

export const MAX_RECIPIENTS = 5000;
const MAX_SCHEDULE_AHEAD_MS = 30 * 24 * 60 * 60 * 1000;

/** Validates a broadcast request; returns { value } or throws 400 with per-row errors. */
export function validateBroadcastRequest(body, { now = new Date(), defaultCountryCode } = {}) {
  const errors = [];
  if (!body || typeof body !== "object" || Array.isArray(body)) throw badRequest("Body must be a JSON object");
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 120) errors.push({ field: "name", message: "is required (max 120 characters)" });
  const t = body.template ?? {};
  if (!isValidTemplateName(t.name)) errors.push({ field: "template.name", message: "must match ^[a-z0-9_]+$" });
  if (typeof t.language !== "string" || !/^[a-z]{2,3}(_[A-Z]{2})?$/.test(t.language)) errors.push({ field: "template.language", message: "must be a language code such as en or en_US" });
  let scheduleAt = null;
  if (body.schedule_at !== undefined && body.schedule_at !== null && body.schedule_at !== "") {
    const d = typeof body.schedule_at === "string" && /(Z|[+-]\d{2}:\d{2})$/.test(body.schedule_at) ? new Date(body.schedule_at) : null;
    if (!d || Number.isNaN(d.getTime())) errors.push({ field: "schedule_at", message: "must be an ISO 8601 timestamp with a time zone" });
    else if (d.getTime() - now.getTime() > MAX_SCHEDULE_AHEAD_MS) errors.push({ field: "schedule_at", message: "must be within 30 days" });
    else if (d > now) scheduleAt = d;
  }
  const list = body.recipients;
  if (!Array.isArray(list) || !list.length) errors.push({ field: "recipients", message: "must be a non-empty array" });
  else if (list.length > MAX_RECIPIENTS) errors.push({ field: "recipients", message: `at most ${MAX_RECIPIENTS} per broadcast` });
  const recipients = [];
  const seen = new Set();
  let duplicates = 0;
  if (Array.isArray(list) && list.length <= MAX_RECIPIENTS) {
    list.forEach((r, i) => {
      const to = normalizePhone(r?.to, { defaultCountryCode });
      if (!to) return errors.push({ field: `recipients[${i}].to`, message: "is not a valid international number" });
      if (r.variables !== undefined && (typeof r.variables !== "object" || r.variables === null || Array.isArray(r.variables))) return errors.push({ field: `recipients[${i}].variables`, message: "must be an object" });
      if (r.header_media !== undefined && !isHttpsUrl(r.header_media?.link)) return errors.push({ field: `recipients[${i}].header_media.link`, message: "must be an https URL" });
      if (seen.has(to)) return duplicates++;
      seen.add(to);
      recipients.push({ to, variables: r.variables ?? {}, ...(r.header_media ? { header_media: { link: r.header_media.link } } : {}) });
    });
  }
  if (body.waba_connection_id !== undefined && (typeof body.waba_connection_id !== "string" || !/^waba_[0-9a-z]{1,64}$/.test(body.waba_connection_id))) errors.push({ field: "waba_connection_id", message: "is invalid" });
  if (errors.length) throw badRequest("Broadcast validation failed", errors.slice(0, 100));
  return { value: { name, template: { name: t.name, language: t.language }, recipients, duplicates, scheduleAt, waba_connection_id: body.waba_connection_id } };
}

export function createBroadcastService({ db, messaging, prices = DEFAULT_PRICES, now = () => new Date(), defaultCountryCode, log = () => {} }) {
  const pending = new Set();

  /** Dispatches due scheduled messages in the background (tracked so serverless hosts can wait). */
  function kick() {
    const p = (async () => {
      for (let i = 0; i < 200; i++) if (!(await messaging.runScheduled(50))) break;
    })()
      .catch((err) => log({ level: "error", msg: "broadcast dispatch failed", error: err?.message }))
      .finally(() => pending.delete(p));
    pending.add(p);
  }

  function present(b) {
    const c = b.counts ?? {};
    const at = now();
    const remaining = (c.scheduled ?? 0) + (c.queued ?? 0);
    const state = b.status === "cancelled" ? "cancelled" : new Date(b.scheduled_for) > at && remaining ? "scheduled" : remaining ? "sending" : "completed";
    return {
      id: b.id,
      name: b.name,
      template: { name: b.template_name, language: b.language },
      waba_connection_id: b.waba_connection_id,
      state,
      total: b.total,
      skipped: b.skipped,
      credits: b.credits,
      counts: { scheduled: c.scheduled ?? 0, queued: c.queued ?? 0, sent: c.sent ?? 0, delivered: c.delivered ?? 0, read: c.read ?? 0, failed: c.failed ?? 0, cancelled: c.cancelled ?? 0 },
      scheduled_for: new Date(b.scheduled_for).toISOString(),
      created_at: new Date(b.created_at).toISOString(),
    };
  }

  return {
    async create(auth, body) {
      const { value: req } = validateBroadcastRequest(body, { now: now(), defaultCountryCode });
      const at = now();
      const sendAt = req.scheduleAt ?? at;
      const created = await db.tx(async (q) => {
        const tenant = await repo.getTenant(q, auth.tenant_id);
        if (!tenant || !["trial", "active"].includes(tenant.status)) throw forbidden("tenant_not_active", `Sending is disabled for this account (${tenant?.status ?? "unknown"})`);
        let conn;
        if (auth.waba_connection_id && req.waba_connection_id && req.waba_connection_id !== auth.waba_connection_id) throw forbidden("connection_not_allowed", "This API key is restricted to another WhatsApp number");
        const connId = req.waba_connection_id ?? auth.waba_connection_id;
        conn = connId ? await repo.getWabaConnection(q, tenant.id, connId) : await repo.getDefaultWabaConnection(q, tenant.id);
        if (!conn) throw connId ? notFound("WhatsApp number not found") : unprocessable("no_default_number", "No default WhatsApp number; pass waba_connection_id");
        if (conn.status !== "connected") throw unprocessable("number_not_connected", "The WhatsApp number is not connected");
        const template = await repo.findTemplate(q, { tenantId: tenant.id, wabaId: conn.waba_id, name: req.template.name, language: req.template.language });
        if (!template) throw unprocessable("template_not_found", `Template ${req.template.name} (${req.template.language}) is not synced for this number`);

        // Build every payload first so a single bad row rejects the whole broadcast.
        const rowErrors = [];
        const built = req.recipients.map((r, i) => {
          try {
            return { ...r, templatePayload: buildTemplatePayload(template, r) };
          } catch (err) {
            if (!(err instanceof TemplateError)) throw err;
            rowErrors.push({ field: `recipients[${i}]`, message: `${r.to}: ${err.message}` });
            return null;
          }
        });
        if (rowErrors.length) throw unprocessable("template_invalid", "Some recipients have invalid template variables", rowErrors.slice(0, 100));

        const prepared = [];
        let skipped = req.duplicates;
        for (const r of built) {
          const contact = await repo.upsertContact(q, { tenantId: tenant.id, phone: r.to, source: "broadcast", now: at });
          if (contact.opted_out_at || contact.blocked_at) {
            skipped++;
            continue;
          }
          const window = await repo.getWindow(q, contact.id, conn.id);
          const price = priceOutbound({ mode: "template", templateCategory: template.category, window, now: sendAt, prices });
          prepared.push({ r, contact, price });
        }
        if (!prepared.length) throw unprocessable("no_recipients", "Every recipient has opted out, is blocked or is a duplicate");

        const total = prepared.reduce((s, p) => s + p.price.credits, 0);
        const balance = await repo.getBalance(q, tenant.id);
        if (balance < total) throw new InsufficientCreditsError(total, balance);

        const broadcast = await repo.insertBroadcast(q, {
          tenant_id: tenant.id,
          name: req.name,
          waba_connection_id: conn.id,
          template_id: template.id,
          template_name: template.name,
          language: template.language,
          total: prepared.length,
          skipped,
          credits: total,
          created_by: auth.user_id ?? auth.id ?? null,
          scheduled_for: sendAt,
          created_at: at,
        });
        for (const { r, contact, price } of prepared) {
          const conversation = await repo.getOrCreateConversation(q, { tenantId: tenant.id, contactId: contact.id, wabaConnectionId: conn.id, now: at });
          const message = await repo.insertMessage(q, {
            tenant_id: tenant.id,
            conversation_id: conversation.id,
            contact_id: contact.id,
            waba_connection_id: conn.id,
            direction: "outbound",
            mode: "template",
            type: "template",
            content: { to: r.to, template: { name: template.name, language: template.language, variables: r.variables }, body: renderTemplateText(template, r.variables), payload: buildOutboundPayload({ to: r.to, type: "template" }, { templatePayload: r.templatePayload }) },
            template_id: template.id,
            status: "scheduled",
            credits_held: price.credits,
            conversation_category: price.category,
            sent_via: "broadcast",
            api_key_id: auth.id ?? null,
            scheduled_for: sendAt,
            broadcast_id: broadcast.id,
            created_at: at,
          });
          await holdCredits(q, { tenantId: tenant.id, amount: price.credits, messageId: message.id, now: at });
        }
        return repo.getBroadcast(q, tenant.id, broadcast.id);
      });
      if (!req.scheduleAt) kick();
      return present(created);
    },

    async list(auth) {
      return (await repo.listBroadcasts(db, auth.tenant_id)).map(present);
    },

    async get(auth, id) {
      const b = await repo.getBroadcast(db, auth.tenant_id, id);
      if (!b) throw notFound("Broadcast not found");
      return present(b);
    },

    /** Cancels messages not yet sent and refunds them. Already-sent messages are unaffected. */
    async cancel(auth, id) {
      const at = now();
      const b = await db.tx(async (q) => {
        const row = (await q.query("select * from broadcasts where tenant_id = $1 and id = $2 for update", [auth.tenant_id, id])).rows[0];
        if (!row) throw notFound("Broadcast not found");
        if (row.status === "cancelled") throw conflict("already_cancelled", "This broadcast is already cancelled");
        const cancelled = await repo.cancelBroadcastMessages(q, id);
        for (const m of cancelled) await refundMessage(q, m, { now: at, note: "broadcast cancelled" });
        await repo.setBroadcastStatus(q, id, "cancelled");
        return repo.getBroadcast(q, auth.tenant_id, id);
      });
      return present(b);
    },

    kick,
    async drain() {
      while (pending.size) await Promise.all([...pending]);
    },
  };
}
