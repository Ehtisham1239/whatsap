// Normalises Meta WhatsApp Cloud API webhook payloads into flat events.
// Docs: https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/components
import { mapMetaTemplateStatus } from "../lib/templates.js";

const STATUS_MAP = { sent: "sent", delivered: "delivered", read: "read", failed: "failed" };

function tsToDate(ts) {
  const n = Number(ts);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000) : null;
}

/** Extracts storable content from an inbound message object. */
export function inboundContent(msg) {
  const type = msg?.type;
  switch (type) {
    case "text":
      return { body: String(msg.text?.body ?? "") };
    case "image":
    case "video":
    case "audio":
    case "document":
    case "sticker": {
      const m = msg[type] || {};
      return {
        media_id: m.id ?? null,
        mime_type: m.mime_type ?? null,
        ...(m.caption ? { caption: m.caption } : {}),
        ...(m.filename ? { filename: m.filename } : {}),
      };
    }
    case "location":
      return { latitude: msg.location?.latitude, longitude: msg.location?.longitude, name: msg.location?.name ?? null, address: msg.location?.address ?? null };
    case "button":
      return { text: msg.button?.text ?? "", payload: msg.button?.payload ?? null };
    case "interactive": {
      const i = msg.interactive || {};
      const reply = i.button_reply || i.list_reply || null;
      return { interactive_type: i.type ?? null, id: reply?.id ?? null, title: reply?.title ?? null, ...(i.nfm_reply ? { response_json: i.nfm_reply.response_json ?? null } : {}) };
    }
    case "reaction":
      return { message_id: msg.reaction?.message_id ?? null, emoji: msg.reaction?.emoji ?? "" };
    case "contacts":
      return { contacts: Array.isArray(msg.contacts) ? msg.contacts : [] };
    default:
      return { unsupported: true, errors: msg?.errors ?? null };
  }
}

/** The text a contact typed or tapped, used for opt-out keyword matching. */
export function inboundText(event) {
  const c = event.content || {};
  if (event.type === "text") return c.body;
  if (event.type === "button") return c.text;
  if (event.type === "interactive") return c.title;
  return "";
}

/**
 * Returns { events, ignored } where each event has a unique `key` for dedupe.
 * Unknown shapes are counted in `ignored` rather than throwing, because Meta
 * retries any non-2xx response.
 */
export function parseWebhook(payload) {
  const events = [];
  let ignored = 0;
  if (!payload || payload.object !== "whatsapp_business_account" || !Array.isArray(payload.entry)) return { events, ignored: 1 };

  for (const entry of payload.entry) {
    const wabaId = entry?.id ? String(entry.id) : null;
    for (const change of entry?.changes ?? []) {
      const value = change?.value ?? {};
      if (change?.field === "messages") {
        const phoneNumberId = value.metadata?.phone_number_id ? String(value.metadata.phone_number_id) : null;
        if (!phoneNumberId) {
          ignored++;
          continue;
        }
        const profiles = new Map((value.contacts ?? []).map((c) => [String(c.wa_id), c.profile?.name ?? null]));
        for (const msg of value.messages ?? []) {
          if (!msg?.id || !msg.from) {
            ignored++;
            continue;
          }
          const from = String(msg.from);
          events.push({
            kind: "inbound",
            key: `in:${msg.id}`,
            wabaId,
            phoneNumberId,
            wamid: String(msg.id),
            from,
            profileName: profiles.get(from) ?? null,
            timestamp: tsToDate(msg.timestamp) ?? new Date(),
            type: String(msg.type || "unknown"),
            content: inboundContent(msg),
            replyTo: msg.context?.id ?? null,
            // A `referral` marks a conversation started from a Click-to-WhatsApp ad.
            ctwa: Boolean(msg.referral && (msg.referral.source_type === "ad" || msg.referral.ctwa_clid)),
          });
        }
        for (const st of value.statuses ?? []) {
          const status = STATUS_MAP[st?.status];
          if (!st?.id || !status) {
            ignored++;
            continue;
          }
          const err = Array.isArray(st.errors) && st.errors[0] ? st.errors[0] : null;
          events.push({
            kind: "status",
            key: `st:${st.id}:${status}`,
            wabaId,
            phoneNumberId,
            wamid: String(st.id),
            status,
            timestamp: tsToDate(st.timestamp) ?? new Date(),
            recipient: st.recipient_id ? String(st.recipient_id) : null,
            pricingCategory: st.pricing?.category ?? st.conversation?.origin?.type ?? null,
            error: err ? { code: String(err.code ?? ""), message: String(err.error_data?.details || err.message || err.title || "") } : null,
          });
        }
      } else if (change?.field === "message_template_status_update") {
        const status = mapMetaTemplateStatus(value.event);
        if (!value.message_template_id || !status) {
          ignored++;
          continue;
        }
        events.push({
          kind: "template_status",
          key: `tpl:${value.message_template_id}:${String(value.event).toUpperCase()}:${entry?.time ?? ""}`,
          wabaId,
          metaTemplateId: String(value.message_template_id),
          name: value.message_template_name ?? null,
          language: value.message_template_language ?? null,
          status,
          reason: value.reason && value.reason !== "NONE" ? String(value.reason) : null,
        });
      } else if (change?.field === "phone_number_quality_update") {
        events.push({
          kind: "quality",
          key: `q:${value.display_phone_number}:${value.event}:${entry?.time ?? ""}`,
          wabaId,
          displayPhone: value.display_phone_number ? String(value.display_phone_number) : null,
          qualityEvent: value.event ?? null,
          messagingTier: value.current_limit ?? null,
        });
      } else {
        ignored++;
      }
    }
  }
  return { events, ignored };
}
