import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import * as repo from "../db/repo.js";
import { safeEqual } from "../lib/crypto.js";
import { AppError, badRequest, forbidden, notFound, unauthorized } from "../lib/errors.js";
import { normalizePhone } from "../lib/phone.js";
import { presentMessage } from "../services/notifier.js";
import { requireManager, SESSION_TTL_MS } from "../services/users.js";
import { decodeCursor, encodeCursor } from "./cursor.js";
import { createRateLimiter } from "./rate-limit.js";
import { createRouter } from "./router.js";

export const MAX_BODY_BYTES = 1024 * 1024;
export const PUBLIC_DIR = fileURLToPath(new URL("../../public", import.meta.url));

const STATIC_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

// The dashboard pages load only same-origin scripts and styles and never inline code.
const PAGE_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

/** Reads a file under PUBLIC_DIR; null for anything outside it or with an unknown type. */
export async function readStatic(relPath, dir = PUBLIC_DIR) {
  const type = STATIC_TYPES[extname(relPath).toLowerCase()];
  if (!type || relPath.includes("\0")) return null;
  const full = normalize(join(dir, relPath));
  if (!full.startsWith(dir + sep)) return null;
  try {
    return { body: await readFile(full), type };
  } catch {
    return null;
  }
}

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

export const SESSION_COOKIE = "wa_session";

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    if (!(k in out)) out[k] = part.slice(i + 1).trim();
  }
  return out;
}

function sessionCookie(value, { secure, maxAgeSeconds }) {
  return [`${SESSION_COOKIE}=${value}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAgeSeconds}`, ...(secure ? ["Secure"] : [])].join("; ");
}

/**
 * Cookie-authenticated writes must carry `X-Requested-With: fetch` (a custom
 * header other sites cannot send without a CORS preflight, which we never
 * grant) and, when present, an Origin matching the Host.
 */
function checkCsrf(req) {
  if (req.headers["x-requested-with"] !== "fetch") throw forbidden("csrf_failed", "Missing X-Requested-With header");
  const origin = req.headers.origin;
  if (origin) {
    let host;
    try {
      host = new URL(origin).host;
    } catch {
      host = null;
    }
    if (host !== req.headers.host) throw forbidden("csrf_failed", "Cross-site request blocked");
  }
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
export function createApp({ db, accounts, messaging, inbound, templates, media, users, broadcasts, ai }, config = {}, { log = () => {}, now = () => new Date() } = {}) {
  const router = createRouter();
  const apiLimiter = createRateLimiter(config.rateLimit ?? { capacity: 50, refillPerSecond: 20 });
  const adminLimiter = createRateLimiter(config.adminRateLimit ?? { capacity: 20, refillPerSecond: 2 });

  const clientIp = (req) => (config.trustProxy ? String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() : "") || req.socket.remoteAddress || "unknown";

  function limit(limiter, key) {
    const r = limiter.take(key);
    if (!r.ok) throw Object.assign(new AppError(429, "rate_limited", "Too many requests"), { headers: { "retry-after": String(r.retryAfterSeconds) } });
  }

  const cookieSecure = config.cookieSecure !== false;
  const authLimiter = createRateLimiter(config.authRateLimit ?? { capacity: 10, refillPerSecond: 0.2 });

  /**
   * Tenant routes accept an API key (servers) or a dashboard session cookie.
   * sessionOnly: dashboard-only (account management). manager: owner/admin only.
   */
  const api = (handler, { sessionOnly = false, manager = false } = {}) => async (ctx) => {
    const key = bearer(ctx.req);
    if (key) {
      if (sessionOnly) throw forbidden("session_required", "This endpoint is only available in the dashboard");
      limit(apiLimiter, `ip:${clientIp(ctx.req)}:${key.slice(0, 12)}`);
      ctx.auth = await accounts.authenticate(key);
      limit(apiLimiter, `key:${ctx.auth.id}`);
    } else {
      const token = parseCookies(ctx.req.headers.cookie)[SESSION_COOKIE];
      if (!token || !users) throw unauthorized();
      limit(apiLimiter, `ip:${clientIp(ctx.req)}`);
      if (ctx.req.method !== "GET") checkCsrf(ctx.req);
      ctx.auth = await users.authenticate(token);
      limit(apiLimiter, `user:${ctx.auth.user_id}`);
    }
    if (manager) requireManager(ctx.auth);
    return handler(ctx);
  };

  const admin = (handler) => async (ctx) => {
    limit(adminLimiter, `admin:${clientIp(ctx.req)}`);
    if (!config.adminToken || !safeEqual(bearer(ctx.req) ?? "", config.adminToken)) throw unauthorized("Missing or invalid admin token");
    return handler(ctx);
  };

  // ---- dashboard (static) ----
  const page = (file) => async () => {
    const f = await readStatic(file, config.publicDir ?? PUBLIC_DIR);
    if (!f) throw notFound("Page not found");
    return { status: 200, binary: f.body, headers: { "content-type": f.type, "content-security-policy": PAGE_CSP } };
  };
  router.get("/", () => ({ status: 302, text: "", headers: { location: "/app" } }));
  router.get("/login", page("login.html"));
  router.get("/signup", page("signup.html"));
  router.get("/app", page("app.html"));
  router.get("/console", page("console.html"));

  // ---- dashboard accounts ----
  const setSession = (token) => ({ "set-cookie": sessionCookie(token, { secure: cookieSecure, maxAgeSeconds: Math.floor(SESSION_TTL_MS / 1000) }) });
  router.post("/auth/signup", async ({ req, body }) => {
    checkCsrf(req);
    limit(authLimiter, `signup:${clientIp(req)}`);
    const r = await users.signup(body, { userAgent: req.headers["user-agent"] });
    return { status: 201, body: { user: r.user, tenant: { id: r.tenant.id, name: r.tenant.name, status: r.tenant.status } }, headers: setSession(r.token) };
  });
  router.post("/auth/login", async ({ req, body }) => {
    checkCsrf(req);
    limit(authLimiter, `login-ip:${clientIp(req)}`);
    if (typeof body.email === "string") limit(authLimiter, `login-email:${body.email.trim().toLowerCase()}`);
    const r = await users.login(body, { userAgent: req.headers["user-agent"] });
    return { status: 200, body: { user: r.user }, headers: setSession(r.token) };
  });
  router.post("/auth/logout", async ({ req }) => {
    checkCsrf(req);
    await users.logout(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
    return { status: 200, body: { signed_out: true }, headers: { "set-cookie": sessionCookie("", { secure: cookieSecure, maxAgeSeconds: 0 }) } };
  });
  router.get("/assets/:file", async ({ params }) => {
    if (!/^[a-z0-9-]+\.(css|js|svg|png|ico)$/.test(params.file)) throw notFound("Asset not found");
    const f = await readStatic(join("assets", params.file), config.publicDir ?? PUBLIC_DIR);
    if (!f) throw notFound("Asset not found");
    return { status: 200, binary: f.body, headers: { "content-type": f.type, "cache-control": "no-cache" } };
  });

  // ---- scheduled jobs (Vercel Cron or any scheduler; Bearer CRON_SECRET) ----
  const cron = async ({ req }) => {
    if (!config.cronSecret || !safeEqual(bearer(req) ?? "", config.cronSecret)) throw unauthorized("Missing or invalid cron secret");
    if (!config.runMaintenance) throw new AppError(503, "not_configured", "Maintenance is not available");
    return { status: 200, body: await config.runMaintenance() };
  };
  router.get("/internal/cron", cron);
  router.post("/internal/cron", cron);

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

  router.get("/v1/ai/settings", api(async ({ auth }) => ({ status: 200, body: await ai.getSettings(auth) }), { sessionOnly: true }));
  router.patch("/v1/ai/settings", api(async ({ auth, body }) => ({ status: 200, body: await ai.saveSettings(auth, body) }), { sessionOnly: true, manager: true }));
  router.post("/v1/conversations/:id/ai", api(async ({ auth, params, body }) => {
    if (typeof body.paused !== "boolean") throw badRequest("paused must be true or false");
    return { status: 200, body: { conversation: await ai.setPaused(auth, params.id, body.paused) } };
  }));
  router.post("/v1/ai/test", api(async ({ auth, body }) => ({ status: 200, body: await ai.test(auth, body) }), { sessionOnly: true }));

  router.get("/v1/broadcasts", api(async ({ auth }) => ({ status: 200, body: { data: await broadcasts.list(auth) } })));
  router.post("/v1/broadcasts", api(async ({ auth, body }) => ({ status: 201, body: { broadcast: await broadcasts.create(auth, body) } })));
  router.get("/v1/broadcasts/:id", api(async ({ auth, params }) => ({ status: 200, body: { broadcast: await broadcasts.get(auth, params.id) } })));
  router.post("/v1/broadcasts/:id/cancel", api(async ({ auth, params }) => ({ status: 200, body: { broadcast: await broadcasts.cancel(auth, params.id) } })));

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
      return {
        status: 200,
        body: {
          data: rows.map((c) => ({
            id: c.id,
            contact_id: c.contact_id,
            phone: c.phone,
            contact_name: c.contact_name,
            waba_connection_id: c.waba_connection_id,
            status: c.status,
            last_message_at: new Date(c.last_message_at).toISOString(),
            last_preview: c.last_preview ? String(c.last_preview).slice(0, 140) : null,
            window_expires_at: c.window_expires_at ? new Date(c.window_expires_at).toISOString() : null,
            ai_paused: Boolean(c.ai_paused),
            opted_out: Boolean(c.opted_out_at),
            blocked: Boolean(c.blocked_at),
          })),
        },
      };
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

  router.post(
    "/v1/conversations/:id/notes",
    api(async ({ auth, params, body }) => ({ status: 201, body: { message: await messaging.addNote(auth, params.id, body.text) } })),
  );

  // ---- account self-service (dashboard sessions) ----
  router.get(
    "/v1/me",
    api(async ({ auth }) => {
      const tenant = auth.tenant ?? { id: auth.tenant_id, name: auth.tenant_name, status: auth.tenant_status };
      return { status: 200, body: { user: auth.user ?? null, tenant, balance: await repo.getBalance(db, auth.tenant_id) } };
    }),
  );
  router.get(
    "/v1/stats",
    api(async ({ auth, url }) => {
      const days = intParam(url.searchParams.get("days"), { def: 7, min: 1, max: 90, name: "days" });
      const at = now();
      const tenant = await repo.getTenant(db, auth.tenant_id);
      const since = new Date(at.getTime() - days * 86400_000);
      return { status: 200, body: { days, balance: await repo.getBalance(db, auth.tenant_id), ...(await repo.tenantStats(db, auth.tenant_id, { since, now: at, timeZone: tenant?.timezone || "UTC" })) } };
    }),
  );
  router.post("/v1/me/password", api(async ({ auth, body }) => ({ status: 200, body: await users.changePassword(auth, body) }), { sessionOnly: true }));
  router.get("/v1/users", api(async ({ auth }) => ({ status: 200, body: { data: await users.listTeam(auth) } }), { sessionOnly: true }));
  router.post("/v1/users", api(async ({ auth, body }) => ({ status: 201, body: { user: await users.addTeammate(auth, body) } }), { sessionOnly: true, manager: true }));
  router.patch("/v1/users/:id", api(async ({ auth, params, body }) => ({ status: 200, body: { user: await users.updateTeammate(auth, params.id, body) } }), { sessionOnly: true, manager: true }));
  router.get("/v1/api-keys", api(async ({ auth }) => ({ status: 200, body: { data: await accounts.listApiKeys(auth.tenant_id) } }), { sessionOnly: true, manager: true }));
  router.post("/v1/api-keys", api(async ({ auth, body }) => ({ status: 201, body: { api_key: await accounts.issueApiKey(auth.tenant_id, { name: body.name, waba_connection_id: body.waba_connection_id }) } }), { sessionOnly: true, manager: true }));
  router.delete("/v1/api-keys/:id", api(async ({ auth, params }) => ({ status: 200, body: { api_key: await accounts.revokeApiKey(auth.tenant_id, params.id) } }), { sessionOnly: true, manager: true }));
  router.get("/v1/webhook-endpoints", api(async ({ auth }) => ({ status: 200, body: { data: await accounts.listWebhookEndpoints(auth.tenant_id) } }), { sessionOnly: true, manager: true }));
  router.post("/v1/webhook-endpoints", api(async ({ auth, body }) => ({ status: 201, body: { webhook_endpoint: await accounts.addWebhookEndpoint(auth.tenant_id, body) } }), { sessionOnly: true, manager: true }));
  router.patch("/v1/webhook-endpoints/:id", api(async ({ auth, params, body }) => ({ status: 200, body: { webhook_endpoint: await accounts.setWebhookEndpointActive(auth.tenant_id, params.id, body.active) } }), { sessionOnly: true, manager: true }));

  // ---- operator admin API ----
  router.get(
    "/admin/tenants",
    admin(async ({ url }) => {
      const limit = intParam(url.searchParams.get("limit"), { def: 100, min: 1, max: 500, name: "limit" });
      const rows = await repo.listTenants(db, { limit, after: url.searchParams.get("after") || undefined });
      return { status: 200, body: { data: rows, next_after: rows.length === limit ? rows.at(-1).id : null } };
    }),
  );
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
