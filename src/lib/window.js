// WhatsApp customer-service window: free-form ("custom") messages may only be
// sent within 24 hours of the contact's last inbound message. A conversation
// opened from a Click-to-WhatsApp ad or Facebook page CTA gets a 72-hour
// free-entry-point window instead.
export const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;
export const CTWA_WINDOW_MS = 72 * 60 * 60 * 1000;

export function windowExpiry(lastInboundAt, source = "user") {
  const t = toMs(lastInboundAt);
  return new Date(t + (source === "ctwa" ? CTWA_WINDOW_MS : SERVICE_WINDOW_MS));
}

/**
 * Computes the window row after an inbound message. A later plain message never
 * shortens an open CTWA window.
 */
export function nextWindow(existing, inboundAt, source = "user") {
  const candidate = { last_inbound_at: new Date(toMs(inboundAt)), expires_at: windowExpiry(inboundAt, source), source };
  if (!existing) return candidate;
  const last = new Date(Math.max(toMs(existing.last_inbound_at), toMs(inboundAt)));
  if (toMs(existing.expires_at) > toMs(candidate.expires_at)) {
    return { last_inbound_at: last, expires_at: new Date(toMs(existing.expires_at)), source: existing.source };
  }
  return { ...candidate, last_inbound_at: last };
}

export function isWindowOpen(window, now = new Date()) {
  return Boolean(window && toMs(window.expires_at) > toMs(now));
}

function toMs(value) {
  const t = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (Number.isNaN(t)) throw new TypeError(`invalid date: ${value}`);
  return t;
}
