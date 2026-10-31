import { randomUUID } from "node:crypto";
import * as repo from "../db/repo.js";
import { safeEqual } from "../lib/crypto.js";
import { AppError, badRequest, notFound, unauthorized } from "../lib/errors.js";
import { normalizePhone } from "../lib/phone.js";
import { presentMessage } from "../services/notifier.js";
import { decodeCursor, encodeCursor } from "./cursor.js";
import { createRateLimiter } from "./rate-limit.js";
import { createRouter } from "./router.js";

export const MAX_BODY_BYTES = 1024 * 1024;

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
};

function send(res, status, body, headers = {}) {
  const isText = typeof body === "string";
  const payload = isText ? body : JSON.stringify(body);
  res.writeHead(status, { ...SECURITY_HEADERS, "content-type": isText ? "text/plain; charset=utf-8" : "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload), ...headers });
  res.end(payload);
}

function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (declared > limit) return reject(new AppError(413, "payload_too_large", `Body exceeds ${limit} bytes`));
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new AppError(413, "payload_too_large", `Body exceeds ${limit} bytes`));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function parseJson(raw) {
  if (!raw.length) return {};
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    throw badRequest("Body must be valid JSON");
  }
}

function intParam(value, { def, min, max, name }) {
  if (value === null || value === undefined || value === "") return def;
  if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) throw badRequest(`${name} must be an integer between ${min} and ${max}`);
  return Number(value);
}

function cursorParam(value) {
  const c = decodeCursor(value);
  if (c === undefined) throw badRequest("before is not a valid cursor");
  return c;
}

function bearer(req) {
  const h = req.headers.authorization || "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : null;
}

/**
 * Builds the request handler.
 * services: { db, accounts, messaging, inbound, templates }
 * config:   { adminToken, metaVerifyToken, trustProxy, rateLimit }
 */
export function createApp({ db, accounts, messaging, inbound, templates, media }, config = {}, { log = () => {}, now = () => new Date() } = {}) {
  const router = createRouter();
  const apiLimiter = createRateLimiter(config.rateLimit ?? { capacity: 50, refillPerSecond: 20 });
  const adminLimiter = createRateLimiter(config.adminRateLimit ?? { capacity: 20, refillPerSecond: 2 });

  const clientIp = (req) => (config.trustProxy ? String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() : "") || req.socket.remoteAddress || "unknown";

  function limit(limiter, key) {
    const r = limiter.take(key);
    if (!r.ok) throw Object.assign(new AppError(429, "rate_limited", "Too many requests"), { headers: { "retry-after": String(r.retryAfterSeconds) } });
  }

  const api = (handler) => async (ctx) => {
    const key = bearer(ctx.req);
    if (!key) throw unauthorized();
    limit(apiLimiter, `ip:${clientIp(ctx.req)}:${key.slice(0, 12)}`);
    ctx.auth = await accounts.authenticate(key);
    limit(apiLimiter, `key:${ctx.auth.id}`);
    return handler(ctx);
  };

  const admin = (handler) => async (ctx) => {
    limit(adminLimiter, `admin:${clientIp(ctx.req)}`);
    if (!config.adminToken || !safeEqual(bearer(ctx.req) ?? "", config.adminToken)) throw unauthorized("Missing or invalid admin token");
    return handler(ctx);
  };

  // ---- health ----
  router.get("/health", () => ({ status: 200, body: { status: "ok" } }));
  router.get("/ready", async () => {
    await db.query("select 1");
    return { status: 200, body: { status: "ready" } };
  });

  // ---- Meta webhooks ----
  router.get("/webhooks/meta", ({ url }) => {
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token") ?? "";
    const challenge = url.searchParams.get("hub.challenge") ?? "";
    if (mode === "subscribe" && config.metaVerifyToken && safeEqual(token, config.metaVerifyToken) && /^[\w-]{1,128}$/.test(challenge)) return { status: 200, text: challenge };
    return { status: 403, body: { error: { code: "forbidden", message: "Verification failed" } } };
  });
  router.post("/webhooks/meta", async ({ req, raw }) => {
    const summary = await inbound.handle(raw, req.headers["x-hub-signature-256"]);
    return { status: 200, body: { received: true, ...summary } };
  });

  // ---- tenant API ----
  router.post(
    "/v1/messages",
    api(async ({ auth, body, req }) => {
      const r = await messaging.send(auth, body, req.headers["idempotency-key"]);
      return { status: r.status, body: r.body, headers: r.replayed ? { "idempotent-replayed": "true" } : {} };
    }),
  );
  router.get(
    "/v1/messages",
    api(async ({ auth, url }) => {
      const limit = intParam(url.searchParams.get("limit"), { def: 50, min: 1, max: 200, name: "limit" });
      const status = url.searchParams.get("status") || undefined;
      const rows = await repo.listMessages(db, auth.tenant_id, {
        limit,
        status,
        before: cursorParam(url.searchParams.get("before")),
        contactId: url.searchParams.get("contact_id") || undefined,
        conversationId: url.searchParams.get("conversation_id") || undefined,
      });
      return { status: 200, body: { data: rows.map(presentMessage), next_cursor: rows.length === limit ? encodeCursor(rows.at(-1)) : null } };
    }),
  );
  router.get("/v1/messages/:id", api(async ({ auth, params }) => ({ status: 200, body: { message: await messaging.get(auth, params.id) } })));
  router.get(
    "/v1/messages/:id/media",
    api(async ({ auth, params }) => {
      const file = await media.download(auth, params.id);
      const safeName = file.filename ? file.filename.replace(/[^\w.-]+/g, "_").slice(0, 100) : null;
      return {
        status: 200,
        binary: file.body,
        headers: {
          "content-type": file.contentType,
          "content-disposition": `attachment${safeName ? `; filename="${safeName}"` : ""}`,
        },
      };
    }),
  );
  router.post("/v1/messages/:id/cancel", api(async ({ auth, params }) => ({ status: 200, body: { message: await messaging.cancel(auth, params.id) } })));

  router.get("/v1/numbers", api(async ({ auth }) => ({ status: 200, body: { data: (await accounts.listNumbers(auth.tenant_id)).filter((n) => !auth.waba_connection_id || n.id === auth.waba_connection_id) } })));

  router.get("/v1/templates", api(async ({ auth, url }) => ({ status: 200, body: { data: await templates.list(auth.tenant_id, { status: url.searchParams.get("status") || undefined }) } })));
  router.post(
    "/v1/templates/sync",
    api(async ({ auth, body }) => {
      let connId = body.waba_connection_id ?? auth.waba_connection_id;
      if (auth.waba_connection_id && connId !== auth.waba_connection_id) throw new AppError(403, "connection_not_allowed", "This API key is restricted to another WhatsApp number");
      if (!connId) connId = (await repo.getDefaultWabaConnection(db, auth.tenant_id))?.id;
      if (!connId) throw badRequest("waba_connection_id is required");
      return { status: 200, body: await templates.sync(auth.tenant_id, connId) };
    }),
  );

  router.get(
    "/v1/wallet",
    api(async ({ auth, url }) => {
      const limit = intParam(url.searchParams.get("limit"), { def: 50, min: 1, max: 200, name: "limit" });
      const rows = await repo.listLedger(db, auth.tenant_id, { limit, before: cursorParam(url.searchParams.get("before")) });
      return {
        status: 200,
        body: {
          balance: await repo.getBalance(db, auth.tenant_id),
          ledger: rows.map((l) => ({ id: l.id, kind: l.kind, amount: l.amount, balance_after: l.balance_after, message_id: l.message_id, note: l.note, created_at: new Date(l.created_at).toISOString() })),
          next_cursor: rows.length === limit ? encodeCursor(rows.at(-1)) : null,
        },
      };
    }),
  );

  router.get(
    "/v1/contacts",
    api(async ({ auth, url }) => {
      const limit = intParam(url.searchParams.get("limit"), { def: 50, min: 1, max: 200, name: "limit" });
      const after = url.searchParams.get("after") || undefined;
      const rows = await repo.listContacts(db, auth.tenant_id, { limit, after });
      return { status: 200, body: { data: rows.map(presentContact), next_after: rows.length === limit ? rows.at(-1).id : null } };
    }),
  );
  router.post(
    "/v1/contacts/:phone/block",
    api(async ({ auth, params, body }) => {
      const phone = normalizePhone(params.phone);
      if (!phone) throw badRequest("phone must be an international number");
      if (typeof body.blocked !== "boolean") throw badRequest("blocked must be true or false");
      if (body.reason !== undefined && (typeof body.reason !== "string" || body.reason.length > 200)) throw badRequest("reason must be at most 200 characters");
      const row = await repo.setContactBlocked(db, auth.tenant_id, phone, { at: body.blocked ? now() : null, reason: body.reason });
      if (!row) throw notFound("Contact not found");
      return { status: 200, body: { contact: presentContact(row) } };
    }),
  );

  router.get(
    "/v1/conversations",
    api(async ({ auth, url }) => {
      const status = url.searchParams.get("status") || undefined;
      if (status && !["open", "pending", "resolved"].includes(status)) throw badRequest("status must be open, pending or resolved");
      const limit = intParam(url.searchParams.get("limit"), { def: 50, min: 1, max: 200, name: "limit" });
      const rows = await repo.listConversations(db, auth.tenant_id, { status, limit });
      return { status: 200, body: { data: rows.map((c) => ({ id: c.id, contact_id: c.contact_id, phone: c.phone, contact_name: c.contact_name, waba_connection_id: c.waba_connection_id, status: c.status, last_message_at: new Date(c.last_message_at).toISOString() })) } };
    }),
  );
  router.post(
    "/v1/conversations/:id/status",
    api(async ({ auth, params, body }) => {
      if (!["open", "pending", "resolved"].includes(body.status)) throw badRequest("status must be open, pending or resolved");
      let row;
      try {
        row = await repo.setConversationStatus(db, auth.tenant_id, params.id, body.status);
      } catch (err) {
        if (err?.code === "23505") throw new AppError(409, "conversation_conflict", "Another active conversation exists for this contact");
        throw err;
      }
      if (!row) throw notFound("Conversation not found");
      return { status: 200, body: { conversation: { id: row.id, status: row.status } } };
    }),
  );

  // ---- operator admin API ----
  router.post("/admin/tenants", admin(async ({ body }) => ({ status: 201, body: { tenant: await accounts.createTenant(body) } })));
  router.get("/admin/tenants/:id", admin(async ({ params }) => ({ status: 200, body: { tenant: await accounts.getTenant(params.id) } })));
  router.patch("/admin/tenants/:id", admin(async ({ params, body }) => ({ status: 200, body: { tenant: await accounts.setTenantStatus(params.id, body.status) } })));
  router.post("/admin/tenants/:id/numbers", admin(async ({ params, body }) => ({ status: 201, body: { number: await accounts.connectNumber(params.id, body) } })));
  router.get("/admin/tenants/:id/numbers", admin(async ({ params }) => ({ status: 200, body: { data: await accounts.listNumbers(params.id) } })));
  router.patch(
    "/admin/tenants/:id/numbers/:nid",
    admin(async ({ params, body }) => {
      let number;
      if (body.status !== undefined) number = await accounts.setNumberStatus(params.id, params.nid, body.status);
      if (body.is_default === true) number = await accounts.setDefaultNumber(params.id, params.nid);
      if (!number) throw badRequest("Provide status and/or is_default: true");
      return { status: 200, body: { number } };
    }),
  );
  router.post("/admin/tenants/:id/api-keys", admin(async ({ params, body }) => ({ status: 201, body: { api_key: await accounts.issueApiKey(params.id, body) } })));
  router.get("/admin/tenants/:id/api-keys", admin(async ({ params }) => ({ status: 200, body: { data: await accounts.listApiKeys(params.id) } })));
  router.delete("/admin/tenants/:id/api-keys/:kid", admin(async ({ params }) => ({ status: 200, body: { api_key: await accounts.revokeApiKey(params.id, params.kid) } })));
  router.post("/admin/tenants/:id/balance", admin(async ({ params, body }) => ({ status: 201, body: await accounts.changeBalance(params.id, body) })));
  router.post("/admin/tenants/:id/webhook-endpoints", admin(async ({ params, body }) => ({ status: 201, body: { webhook_endpoint: await accounts.addWebhookEndpoint(params.id, body) } })));
  router.get("/admin/tenants/:id/webhook-endpoints", admin(async ({ params }) => ({ status: 200, body: { data: await accounts.listWebhookEndpoints(params.id) } })));
  router.patch("/admin/tenants/:id/webhook-endpoints/:eid", admin(async ({ params, body }) => ({ status: 200, body: { webhook_endpoint: await accounts.setWebhookEndpointActive(params.id, params.eid, body.active) } })));
  router.post(
    "/admin/tenants/:id/templates/sync",
    admin(async ({ params, body }) => {
      if (typeof body.waba_connection_id !== "string") throw badRequest("waba_connection_id is required");
      return { status: 200, body: await templates.sync(params.id, body.waba_connection_id) };
    }),
  );

  return async function handle(req, res) {
    const started = Date.now();
    const requestId = randomUUID();
    let status = 500;
    try {
      const url = new URL(req.url, "http://localhost");
      const match = router.match(req.method, url.pathname);
      if (!match) throw notFound("Route not found");
      if (match.allowed) throw Object.assign(new AppError(405, "method_not_allowed", "Method not allowed"), { headers: { allow: match.allowed.join(", ") } });
      let raw = Buffer.alloc(0);
      let body = {};
      if (req.method === "POST" || req.method === "PATCH") {
        const type = String(req.headers["content-type"] || "");
        raw = await readBody(req);
        if (raw.length && !type.startsWith("application/json")) throw new AppError(415, "unsupported_media_type", "Content-Type must be application/json");
        if (url.pathname !== "/webhooks/meta") body = parseJson(raw);
        if (body === null || typeof body !== "object" || Array.isArray(body)) {
          if (url.pathname !== "/v1/messages") throw badRequest("Body must be a JSON object");
        }
      }
      const out = await match.handler({ req, url, params: match.params, raw, body });
      status = out.status;
      if (out.binary) {
        res.writeHead(out.status, { ...SECURITY_HEADERS, "content-length": out.binary.length, "x-request-id": requestId, ...out.headers });
        res.end(out.binary);
      } else send(res, out.status, out.text ?? out.body, { "x-request-id": requestId, ...(out.headers ?? {}) });
    } catch (err) {
      if (err instanceof AppError) {
        status = err.status;
        send(res, err.status, err.toJSON(), { "x-request-id": requestId, ...(err.headers ?? {}) });
      } else {
        status = 500;
        log({ level: "error", msg: "unhandled error", request_id: requestId, error: err?.message, stack: err?.stack });
        send(res, 500, { error: { code: "internal_error", message: "Something went wrong", request_id: requestId } }, { "x-request-id": requestId });
      }
    } finally {
      log({ level: status >= 500 ? "error" : "info", msg: "request", request_id: requestId, method: req.method, path: req.url?.split("?")[0], status, ms: Date.now() - started });
    }
  };
}

function presentContact(c) {
  return {
    id: c.id,
    phone: c.phone,
    name: c.name,
    source: c.source,
    opted_out: Boolean(c.opted_out_at),
    blocked: Boolean(c.blocked_at),
    block_reason: c.block_reason,
    created_at: new Date(c.created_at).toISOString(),
  };
}
