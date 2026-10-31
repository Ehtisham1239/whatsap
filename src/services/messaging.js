// Outbound messaging: validate -> idempotency -> contact/conversation ->
// window + template rules -> credit hold -> Cloud API -> status + refunds.
import * as repo from "../db/repo.js";
import { decryptSecret, sha256Hex, stableStringify } from "../lib/crypto.js";
import { AppError, badRequest, conflict, forbidden, notFound, unprocessable } from "../lib/errors.js";
import { DEFAULT_PRICES, priceOutbound } from "../lib/pricing.js";
import { nextOutboundStatus, statusTimestamps } from "../lib/status.js";
import { buildTemplatePayload, renderTemplateText, TemplateError } from "../lib/templates.js";
import { validateIdempotencyKey, validateSendRequest } from "../lib/validation.js";
import { isWindowOpen } from "../lib/window.js";
import { buildOutboundPayload, MetaApiError } from "../meta/client.js";
import { presentMessage } from "./notifier.js";
import { holdCredits, refundMessage } from "./wallet.js";

const SENDING_TENANT_STATUSES = new Set(["trial", "active"]);

export function createMessagingService({
  db,
  meta,
  encryptionKey,
  prices = DEFAULT_PRICES,
  now = () => new Date(),
  notifier = { emit() {} },
  defaultCountryCode,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  maxSendAttempts = 3,
  log = () => {},
}) {
  async function resolveConnection(q, auth, requestedId) {
    let conn;
    if (requestedId) {
      if (auth.waba_connection_id && auth.waba_connection_id !== requestedId) throw forbidden("connection_not_allowed", "This API key is restricted to another WhatsApp number");
      conn = await repo.getWabaConnection(q, auth.tenant_id, requestedId);
      if (!conn) throw notFound("WhatsApp number not found");
    } else if (auth.waba_connection_id) {
      conn = await repo.getWabaConnection(q, auth.tenant_id, auth.waba_connection_id);
    } else {
      conn = await repo.getDefaultWabaConnection(q, auth.tenant_id);
      if (!conn) throw unprocessable("no_default_number", "No default WhatsApp number; pass waba_connection_id");
    }
    if (!conn || conn.status !== "connected") throw unprocessable("number_not_connected", "The WhatsApp number is not connected");
    return conn;
  }

  /** Creates the message row (queued or scheduled) and holds its credits, all in one transaction. */
  async function enqueue(auth, req, idempotencyKey) {
    const at = now();
    return db.tx(async (q) => {
      const tenant = await repo.getTenant(q, auth.tenant_id);
      if (!tenant || !SENDING_TENANT_STATUSES.has(tenant.status)) throw forbidden("tenant_not_active", `Sending is disabled for this account (${tenant?.status ?? "unknown"})`);
      const conn = await resolveConnection(q, auth, req.waba_connection_id);

      const contact = await repo.upsertContact(q, { tenantId: tenant.id, phone: req.to, source: "api", now: at });
      if (contact.blocked_at) throw unprocessable("contact_blocked", "This contact is blocked");
      if (contact.opted_out_at) throw unprocessable("contact_opted_out", "This contact has opted out of messages");

      const window = await repo.getWindow(q, contact.id, conn.id);
      const sendAt = req.schedule_at ?? at;
      let mode = "custom";
      let template = null;
      let templatePayload = null;
      if (req.type === "template") {
        mode = "template";
        template = await repo.findTemplate(q, { tenantId: tenant.id, wabaId: conn.waba_id, name: req.template.name, language: req.template.language });
        if (!template) throw unprocessable("template_not_found", `Template ${req.template.name} (${req.template.language}) is not synced for this number`);
        try {
          templatePayload = buildTemplatePayload(template, req.template);
        } catch (err) {
          if (err instanceof TemplateError) throw unprocessable("template_invalid", err.message, err.details);
          throw err;
        }
      } else if (!isWindowOpen(window, sendAt)) {
        throw unprocessable("outside_service_window", "Free-form messages need the contact to have messaged you within 24 hours; send an approved template instead");
      }

      const price = priceOutbound({ mode, templateCategory: template?.category, window, now: sendAt, prices });
      const conversation = await repo.getOrCreateConversation(q, { tenantId: tenant.id, contactId: contact.id, wabaConnectionId: conn.id, now: at });
      const payload = buildOutboundPayload(req, { templatePayload });
      const content = {
        to: req.to,
        ...(req.text ? { body: req.text.body } : {}),
        ...(req.media ? { media: req.media } : {}),
        ...(req.template ? { template: { name: req.template.name, language: req.template.language, variables: req.template.variables }, body: renderTemplateText(template, req.template.variables) } : {}),
        ...(req.client_reference ? { client_reference: req.client_reference } : {}),
        payload,
      };
      const message = await repo.insertMessage(q, {
        tenant_id: tenant.id,
        conversation_id: conversation.id,
        contact_id: contact.id,
        waba_connection_id: conn.id,
        direction: "outbound",
        mode,
        type: req.type,
        content,
        template_id: template?.id ?? null,
        status: req.schedule_at ? "scheduled" : "queued",
        credits_held: price.credits,
        conversation_category: price.category,
        sent_via: "api",
        api_key_id: auth.id ?? null,
        idempotency_key: idempotencyKey,
        scheduled_for: req.schedule_at ?? null,
        created_at: at,
      });
      await holdCredits(q, { tenantId: tenant.id, amount: price.credits, messageId: message.id, now: at });
      await repo.touchConversation(q, conversation.id, at);
      return message;
    });
  }

  async function finishFailure(id, error) {
    const at = now();
    return db.tx(async (q) => {
      const m = await repo.lockMessage(q, id);
      if (!m || !nextOutboundStatus(m.status, "failed")) return m;
      const updated = await repo.updateMessage(q, id, { status: "failed", error_code: error.code, error_message: error.message, ...statusTimestamps("failed", at, m) });
      await refundMessage(q, updated, { now: at, note: `send failed: ${error.code}` });
      return repo.lockMessage(q, id);
    });
  }

  /**
   * Sends one queued message to the Cloud API. Safe to call more than once:
   * only a message still `queued` without a wamid is sent.
   */
  async function dispatch(messageId) {
    const message = (await db.query("select * from messages where id = $1", [messageId])).rows[0];
    if (!message || message.status !== "queued" || message.wamid) return message ?? null;
    const conn = (await db.query("select * from waba_connections where id = $1", [message.waba_connection_id])).rows[0];
    if (!conn || conn.status !== "connected") return finishFailure(message.id, { code: "number_not_connected", message: "The WhatsApp number is not connected" });

    let token;
    try {
      token = decryptSecret(conn.token_cipher, encryptionKey, conn.id);
    } catch {
      log({ level: "error", msg: "token decrypt failed", waba_connection_id: conn.id });
      return finishFailure(message.id, { code: "token_unavailable", message: "The WhatsApp access token could not be read; reconnect the number" });
    }

    let wamid = null;
    let lastError = null;
    for (let attempt = 1; attempt <= maxSendAttempts && !wamid; attempt++) {
      try {
        wamid = await meta.sendMessage({ phoneNumberId: conn.phone_number_id, token, payload: message.content.payload });
      } catch (err) {
        if (!(err instanceof MetaApiError)) throw err;
        lastError = err;
        if (err.ambiguous || !err.retryable || attempt === maxSendAttempts) break;
        await sleep(250 * 2 ** (attempt - 1));
      }
    }

    if (!wamid) {
      if (lastError.ambiguous) {
        // The request may have reached Meta: keep it queued; the stuck-message sweeper resolves it.
        await db.query("update messages set error_code = $2, error_message = $3 where id = $1 and status = 'queued'", [message.id, lastError.code, lastError.message]);
        log({ level: "warn", msg: "send outcome unknown", message_id: message.id, code: lastError.code });
        return (await db.query("select * from messages where id = $1", [message.id])).rows[0];
      }
      const failed = await finishFailure(message.id, lastError);
      notifier.emit(failed.tenant_id, "message.status", presentMessage(failed));
      return failed;
    }

    const at = now();
    const sent = await db.tx(async (q) => {
      const m = await repo.lockMessage(q, message.id);
      if (m.status !== "queued") return repo.updateMessage(q, m.id, { wamid });
      let updated = await repo.updateMessage(q, m.id, { status: "sent", wamid, error_code: null, error_message: null, ...statusTimestamps("sent", at, m) });
      // Status webhooks can beat our own write of the wamid; apply any that were parked.
      const parked = await q.query("select payload from webhook_events where left(event_key, length($1)) = $1 order by received_at", [`st:${wamid}:`]);
      for (const { payload } of parked.rows) updated = (await applyStatus(q, updated, payload, at)) ?? updated;
      return updated;
    });
    notifier.emit(sent.tenant_id, "message.status", presentMessage(sent));
    return sent;
  }

  return {
    /**
     * POST /v1/messages. Returns { status, body, replayed? }.
     * @param auth row from authenticateApiKey (id, tenant_id, waba_connection_id)
     */
    async send(auth, body, rawIdempotencyKey) {
      const idem = validateIdempotencyKey(rawIdempotencyKey);
      if (idem.error) throw badRequest(idem.error);
      const parsed = validateSendRequest(body, { now: now(), defaultCountryCode });
      if (parsed.errors) throw badRequest("Request validation failed", parsed.errors);
      const key = idem.value;

      if (key) {
        const requestHash = sha256Hex(stableStringify(body));
        const claim = await repo.claimIdempotencyKey(db, { tenantId: auth.tenant_id, key, requestHash, now: now() });
        if (!claim.inserted) {
          if (claim.row.request_hash !== requestHash) throw unprocessable("idempotency_key_reused", "This Idempotency-Key was used with a different request body");
          if (claim.row.response === null) throw conflict("request_in_progress", "A request with this Idempotency-Key is still being processed");
          return { status: claim.row.response_status, body: claim.row.response, replayed: true };
        }
      }

      let result;
      try {
        const message = await enqueue(auth, parsed.value, key);
        const final = message.status === "queued" ? await dispatch(message.id) : message;
        result = { status: 202, body: { message: presentMessage(final) } };
      } catch (err) {
        if (key) {
          if (err instanceof AppError && err.status < 500) await repo.completeIdempotencyKey(db, { tenantId: auth.tenant_id, key, status: err.status, response: err.toJSON() });
          else await repo.releaseIdempotencyKey(db, { tenantId: auth.tenant_id, key });
        }
        throw err;
      }
      if (key) await repo.completeIdempotencyKey(db, { tenantId: auth.tenant_id, key, status: result.status, response: result.body });
      return result;
    },

    dispatch,

    async get(auth, id) {
      const m = await repo.getMessage(db, auth.tenant_id, id);
      if (!m) throw notFound("Message not found");
      return presentMessage(m);
    },

    /** Cancels a scheduled (not yet sent) message and refunds its credits. */
    async cancel(auth, id) {
      const at = now();
      const m = await db.tx(async (q) => {
        const row = (await q.query("select * from messages where tenant_id = $1 and id = $2 for update", [auth.tenant_id, id])).rows[0];
        if (!row) throw notFound("Message not found");
        if (row.status !== "scheduled") throw conflict("not_cancellable", `A ${row.status} message cannot be cancelled`);
        const updated = await repo.updateMessage(q, id, { status: "cancelled" });
        await refundMessage(q, updated, { now: at, note: "cancelled" });
        return repo.lockMessage(q, id);
      });
      return presentMessage(m);
    },

    /** Worker tick: dispatches due scheduled messages. Returns how many were attempted. */
    async runScheduled(limit = 50) {
      const due = await db.tx((q) => repo.claimDueScheduled(q, now(), limit));
      for (const m of due) {
        try {
          await dispatch(m.id);
        } catch (err) {
          log({ level: "error", msg: "scheduled dispatch failed", message_id: m.id, error: err?.message });
        }
      }
      return due.length;
    },

    /**
     * Worker tick: queued messages with no wamid older than `olderThanMs` never
     * got a definite answer from Meta. Mark them failed and refund.
     */
    async sweepStuck(olderThanMs = 10 * 60 * 1000) {
      const stuck = await repo.findStuckQueued(db, new Date(now().getTime() - olderThanMs));
      for (const m of stuck) {
        const failed = await finishFailure(m.id, { code: m.error_code || "send_timeout", message: "No confirmation from WhatsApp; the message was marked failed and credits refunded" });
        if (failed?.status === "failed") notifier.emit(failed.tenant_id, "message.status", presentMessage(failed));
      }
      return stuck.length;
    },
  };
}

/**
 * Applies a parsed status event to a locked message row inside a transaction.
 * Returns the updated row, or null when the event is stale.
 */
export async function applyStatus(q, message, event, at) {
  const next = nextOutboundStatus(message.status, event.status);
  if (!next) return null;
  const when = event.timestamp ? new Date(event.timestamp) : at;
  const fields = { status: next, ...statusTimestamps(next, when, message) };
  if (next === "failed") {
    fields.error_code = event.error?.code || "failed";
    fields.error_message = event.error?.message || "WhatsApp reported the message as failed";
  }
  const updated = await repo.updateMessage(q, message.id, fields);
  if (next === "failed") await refundMessage(q, updated, { now: at, note: `delivery failed: ${fields.error_code}` });
  return updated;
}
