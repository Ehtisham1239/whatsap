// Outbound status progression. Meta webhooks can arrive out of order or be
// replayed, so a status only ever moves forward.
const RANK = { scheduled: 0, queued: 1, sent: 2, delivered: 3, read: 4 };
const TERMINAL = new Set(["failed", "received", "cancelled"]);

/** Returns the status to store, or null when the incoming status must be ignored. */
export function nextOutboundStatus(current, incoming) {
  if (current === incoming) return null;
  if (TERMINAL.has(current)) return null;
  if (incoming === "failed") return current === "delivered" || current === "read" ? null : "failed";
  if (incoming === "cancelled") return current === "scheduled" || current === "queued" ? "cancelled" : null;
  if (!(incoming in RANK) || !(current in RANK)) return null;
  return RANK[incoming] > RANK[current] ? incoming : null;
}

/** Timestamp columns implied by reaching `status` (read implies delivered). */
export function statusTimestamps(status, at, existing = {}) {
  const ts = at instanceof Date ? at : new Date(at);
  const out = {};
  if ((status === "sent" || status === "delivered" || status === "read") && !existing.sent_at) out.sent_at = ts;
  if ((status === "delivered" || status === "read") && !existing.delivered_at) out.delivered_at = ts;
  if (status === "read" && !existing.read_at) out.read_at = ts;
  if (status === "failed" && !existing.failed_at) out.failed_at = ts;
  return out;
}
