// Processes verified Meta webhooks: inbound messages, delivery statuses,
// template reviews and number quality changes. Each event is processed in its
// own transaction together with its dedupe record, so a failure rolls back
// and Meta's retry processes it again, while replays are skipped.
import * as repo from "../db/repo.js";
import { verifyMetaSignature } from "../lib/crypto.js";
import { AppError } from "../lib/errors.js";
import { normalizePhone } from "../lib/phone.js";
import { nextWindow } from "../lib/window.js";
import { inboundText, parseWebhook } from "../meta/webhook-parser.js";
import { applyStatus } from "./messaging.js";
import { presentMessage } from "./notifier.js";

export const OPT_OUT_KEYWORDS = Object.freeze(["STOP", "STOP ALL", "UNSUBSCRIBE", "OPT OUT", "OPTOUT"]);
export const OPT_IN_KEYWORDS = Object.freeze(["START", "SUBSCRIBE", "OPT IN", "UNSTOP"]);

export function keywordIntent(text) {
  const t = String(text ?? "").trim().toUpperCase().replace(/[.!\s]+$/g, "").replace(/\s+/g, " ");
  if (OPT_OUT_KEYWORDS.includes(t)) return "opt_out";
  if (OPT_IN_KEYWORDS.includes(t)) return "opt_in";
  return null;
}

export function createInboundService({ db, appSecret, now = () => new Date(), notifier = { emit() {} }, log = () => {} }) {
  async function handleInbound(q, e, at) {
    const conn = await repo.findWabaByPhoneNumberId(q, e.phoneNumberId);
    if (!conn) return { skipped: "unknown_number" };
    const phone = normalizePhone(e.from);
    if (!phone) return { skipped: "invalid_sender" };

    const contact = await repo.upsertContact(q, { tenantId: conn.tenant_id, phone, name: e.profileName, source: "whatsapp", now: at });
    const existing = await repo.lockWindow(q, contact.id, conn.id);
    const window = nextWindow(existing, e.timestamp, e.ctwa ? "ctwa" : "user");
    await repo.saveWindow(q, { tenantId: conn.tenant_id, contactId: contact.id, wabaConnectionId: conn.id, window });

    const conversation = await repo.getOrCreateConversation(q, { tenantId: conn.tenant_id, contactId: contact.id, wabaConnectionId: conn.id, now: e.timestamp });
    const message = await repo.insertMessage(q, {
      tenant_id: conn.tenant_id,
      conversation_id: conversation.id,
      contact_id: contact.id,
      waba_connection_id: conn.id,
      direction: "inbound",
      mode: "custom",
      type: e.type,
      content: { from: phone, ...e.content, ...(e.replyTo ? { reply_to: e.replyTo } : {}), ...(e.ctwa ? { ctwa: true } : {}) },
      status: "received",
      wamid: e.wamid,
      sent_via: "webhook",
      created_at: e.timestamp,
    });
    if (!message) return { skipped: "duplicate_wamid" };
    await repo.touchConversation(q, conversation.id, e.timestamp, { reopen: true });

    const out = [{ type: "message.received", data: presentMessage(message) }];
    const intent = keywordIntent(inboundText(e));
    if (intent === "opt_out" && !contact.opted_out_at) {
      await repo.setContactOptOut(q, contact.id, at);
      out.push({ type: "contact.opted_out", data: { contact_id: contact.id, phone } });
    } else if (intent === "opt_in" && contact.opted_out_at) {
      await repo.setContactOptOut(q, contact.id, null);
      out.push({ type: "contact.opted_in", data: { contact_id: contact.id, phone } });
    }
    return { tenantId: conn.tenant_id, notify: out };
  }

  async function handleStatus(q, e, at) {
    const message = await repo.lockMessageByWamid(q, e.wamid);
    // Unknown wamid: our send may not have stored it yet. The event stays in
    // webhook_events and is applied when the wamid is saved (see dispatch()).
    if (!message) return { skipped: "unknown_wamid" };
    const updated = await applyStatus(q, message, e, at);
    if (!updated) return { skipped: "stale_status" };
    return { tenantId: updated.tenant_id, notify: [{ type: "message.status", data: presentMessage(updated) }] };
  }

  async function handleTemplateStatus(q, e, at) {
    if (!e.wabaId) return { skipped: "no_waba" };
    const rows = await repo.updateTemplateStatusByMetaId(q, { wabaId: e.wabaId, metaId: e.metaTemplateId, status: e.status, reason: e.reason, now: at });
    if (!rows.length) return { skipped: "unknown_template" };
    return rows.map((t) => ({ tenantId: t.tenant_id, notify: [{ type: "template.status", data: { template_id: t.id, name: t.name, language: t.language, status: t.status, reason: t.reject_reason } }] }));
  }

  async function handleQuality(q, e) {
    if (!e.wabaId || !e.displayPhone) return { skipped: "incomplete" };
    const conns = await repo.findWabaByDisplayPhone(q, e.wabaId, e.displayPhone);
    for (const c of conns) {
      const fields = {};
      if (e.messagingTier) fields.messaging_tier = String(e.messagingTier);
      if (e.qualityEvent === "FLAGGED") fields.quality_rating = "RED";
      else if (e.qualityEvent === "UNFLAGGED") fields.quality_rating = "GREEN";
      await repo.updateWabaConnection(q, c.id, fields);
    }
    return { skipped: conns.length ? undefined : "unknown_number" };
  }

  const handlers = { inbound: handleInbound, status: handleStatus, template_status: handleTemplateStatus, quality: handleQuality };

  return {
    /** Verifies and processes one webhook delivery. Throws 401 on a bad signature. */
    async handle(rawBody, signatureHeader) {
      if (!verifyMetaSignature(rawBody, signatureHeader, appSecret)) throw new AppError(401, "invalid_signature", "Invalid webhook signature");
      let payload;
      try {
        payload = JSON.parse(rawBody.toString("utf8"));
      } catch {
        throw new AppError(400, "invalid_json", "Webhook body is not valid JSON");
      }
      const { events, ignored } = parseWebhook(payload);
      const summary = { processed: 0, duplicates: 0, skipped: 0, ignored };
      for (const e of events) {
        const at = now();
        const results = await db.tx(async (q) => {
          if (!(await repo.recordWebhookEvent(q, { key: e.key, payload: e, now: at }))) return "duplicate";
          return handlers[e.kind](q, e, at);
        });
        if (results === "duplicate") {
          summary.duplicates++;
          continue;
        }
        const list = Array.isArray(results) ? results : [results];
        if (list.every((r) => r?.skipped)) summary.skipped++;
        else summary.processed++;
        for (const r of list) for (const n of r?.notify ?? []) notifier.emit(r.tenantId, n.type, n.data);
      }
      if (summary.skipped) log({ level: "info", msg: "webhook events skipped", ...summary });
      return summary;
    },
  };
}
