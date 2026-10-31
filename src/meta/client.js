// Minimal WhatsApp Cloud API client. `fetch` is injected for tests.
export const DEFAULT_GRAPH_VERSION = "v23.0";

// Codes where retrying later may succeed (rate limits, temporary outages).
const RETRYABLE_CODES = new Set(["1", "2", "4", "17", "341", "130429", "131000", "131016", "131048", "131056", "133004"]);

export class MetaApiError extends Error {
  constructor({ status, code, message, retryable, ambiguous = false }) {
    super(message);
    this.name = "MetaApiError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    // True when the request may have reached Meta (timeout / network drop): the
    // message might have been sent, so do not refund or resend blindly.
    this.ambiguous = ambiguous;
  }
}

export function createMetaClient({ fetch = globalThis.fetch, graphVersion = DEFAULT_GRAPH_VERSION, baseUrl = "https://graph.facebook.com", timeoutMs = 15000 } = {}) {
  async function call(method, path, token, body) {
    let res;
    try {
      res = await fetch(`${baseUrl}/${graphVersion}/${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new MetaApiError({ status: 0, code: "network_error", message: `Meta API request failed: ${err?.name === "TimeoutError" ? "timeout" : err?.message || "network error"}`, retryable: true, ambiguous: true });
    }
    let json = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    if (!res.ok || json?.error) {
      const e = json?.error ?? {};
      const code = String(e.code ?? res.status);
      throw new MetaApiError({
        status: res.status,
        code,
        message: String(e.error_data?.details || e.message || `Meta API HTTP ${res.status}`).slice(0, 500),
        retryable: res.status >= 500 || res.status === 429 || RETRYABLE_CODES.has(code),
        ambiguous: res.status >= 500 && !json?.error,
      });
    }
    return json;
  }

  return {
    /** Sends a message; returns the wamid. */
    async sendMessage({ phoneNumberId, token, payload }) {
      if (!/^\d+$/.test(String(phoneNumberId))) throw new TypeError("phoneNumberId must be numeric");
      const json = await call("POST", `${phoneNumberId}/messages`, token, { messaging_product: "whatsapp", recipient_type: "individual", ...payload });
      const wamid = json?.messages?.[0]?.id;
      if (!wamid) throw new MetaApiError({ status: 200, code: "no_message_id", message: "Meta API response had no message id", retryable: false, ambiguous: true });
      return wamid;
    },

    /** Lists all templates of a WABA (follows paging). */
    async listTemplates({ wabaId, token, limit = 100, maxPages = 20 }) {
      if (!/^\d+$/.test(String(wabaId))) throw new TypeError("wabaId must be numeric");
      const out = [];
      let path = `${wabaId}/message_templates?fields=id,name,language,status,category,components,parameter_format,rejected_reason&limit=${limit}`;
      for (let page = 0; page < maxPages && path; page++) {
        const json = await call("GET", path, token);
        out.push(...(json?.data ?? []));
        const after = json?.paging?.cursors?.after;
        path = json?.paging?.next && after ? `${wabaId}/message_templates?fields=id,name,language,status,category,components,parameter_format,rejected_reason&limit=${limit}&after=${encodeURIComponent(after)}` : null;
      }
      return out;
    },

    /** Reads phone number details (display number, quality rating, messaging tier). */
    async getPhoneNumber({ phoneNumberId, token }) {
      if (!/^\d+$/.test(String(phoneNumberId))) throw new TypeError("phoneNumberId must be numeric");
      return call("GET", `${phoneNumberId}?fields=display_phone_number,verified_name,quality_rating,messaging_limit_tier`, token);
    },
  };
}

/** Builds the Cloud API payload (minus messaging_product) for a validated send request. */
export function buildOutboundPayload(request, { to, templatePayload, replyTo } = {}) {
  const base = { to: to ?? request.to, ...(replyTo ? { context: { message_id: replyTo } } : {}) };
  switch (request.type) {
    case "text":
      return { ...base, type: "text", text: { body: request.text.body, preview_url: Boolean(request.text.preview_url) } };
    case "image":
    case "video":
    case "audio":
    case "document":
      return { ...base, type: request.type, [request.type]: { ...request.media } };
    case "template":
      if (!templatePayload) throw new TypeError("templatePayload is required for template messages");
      return { ...base, type: "template", template: templatePayload };
    default:
      throw new TypeError(`unsupported message type ${request.type}`);
  }
}
