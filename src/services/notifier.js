// Delivers platform events to tenant webhook endpoints, signed with the
// endpoint secret. Delivery is best effort with bounded retries; it never
// throws into the caller and never blocks the request that caused it.
import { randomUUID } from "node:crypto";
import * as repo from "../db/repo.js";
import { signTenantWebhook } from "../lib/crypto.js";

export const EVENT_TYPES = Object.freeze(["message.received", "message.status", "contact.opted_out", "contact.opted_in", "template.status"]);

export function createNotifier({ db, fetch = globalThis.fetch, now = () => new Date(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), attempts = 3, timeoutMs = 5000, log = () => {} }) {
  const pending = new Set();

  async function deliver(endpoint, body) {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const ts = Math.floor(now().getTime() / 1000);
        const res = await fetch(endpoint.url, {
          method: "POST",
          headers: { "content-type": "application/json", "x-wa-signature": signTenantWebhook(body, endpoint.secret, ts), "user-agent": "wa-platform-webhooks/1" },
          body,
          redirect: "manual",
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.status >= 200 && res.status < 300) return true;
        if (res.status < 500 && res.status !== 429) {
          log({ level: "warn", msg: "tenant webhook rejected", endpoint: endpoint.id, status: res.status });
          return false;
        }
      } catch (err) {
        if (attempt === attempts) log({ level: "warn", msg: "tenant webhook failed", endpoint: endpoint.id, error: err?.message });
      }
      if (attempt < attempts) await sleep(500 * 2 ** (attempt - 1));
    }
    return false;
  }

  async function run(tenantId, type, data) {
    const endpoints = (await repo.listActiveWebhookEndpoints(db, tenantId)).filter((e) => e.events.includes("*") || e.events.includes(type));
    if (!endpoints.length) return;
    const body = JSON.stringify({ id: `evt_${randomUUID()}`, type, created_at: now().toISOString(), tenant_id: tenantId, data });
    await Promise.all(endpoints.map((e) => deliver(e, body)));
  }

  return {
    emit(tenantId, type, data) {
      const p = run(tenantId, type, data)
        .catch((err) => log({ level: "error", msg: "notifier error", error: err?.message }))
        .finally(() => pending.delete(p));
      pending.add(p);
    },
    /** Waits for in-flight deliveries (tests and graceful shutdown). */
    async drain() {
      while (pending.size) await Promise.all([...pending]);
    },
  };
}

/** Public, client-facing view of a message row. */
export function presentMessage(m) {
  if (!m) return null;
  return {
    id: m.id,
    direction: m.direction,
    mode: m.mode,
    type: m.type,
    status: m.status,
    to: m.direction === "outbound" ? m.content?.to ?? null : undefined,
    contact_id: m.contact_id,
    conversation_id: m.conversation_id,
    waba_connection_id: m.waba_connection_id,
    content: publicContent(m.content),
    wamid: m.wamid,
    category: m.conversation_category,
    credits: m.credits_held,
    credits_refunded: m.credits_refunded,
    error: m.error_code ? { code: m.error_code, message: m.error_message } : null,
    scheduled_for: iso(m.scheduled_for),
    sent_at: iso(m.sent_at),
    delivered_at: iso(m.delivered_at),
    read_at: iso(m.read_at),
    failed_at: iso(m.failed_at),
    created_at: iso(m.created_at),
  };
}

function publicContent(content) {
  if (!content || typeof content !== "object") return content ?? null;
  const { payload, ...rest } = content; // the raw Cloud API payload is internal
  return rest;
}

const iso = (d) => (d ? new Date(d).toISOString() : null);
