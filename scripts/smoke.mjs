// End-to-end smoke test of the real entrypoint (src/index.js) with the
// production `pg` driver, against an in-process Postgres (PGlite over the wire
// protocol) and a local fake of the Graph API. Nothing external is contacted.
//   node scripts/smoke.mjs
import { spawn } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

const DB_PORT = 55432;
const API_PORT = 58080;
const META_PORT = 59090;
const env = {
  ...process.env,
  PORT: String(API_PORT),
  DATABASE_URL: `postgresql://postgres:postgres@127.0.0.1:${DB_PORT}/postgres`,
  DATABASE_SSL: "false",
  DATABASE_POOL_MAX: "1", // the PGlite socket server accepts one connection at a time
  ADMIN_TOKEN: randomBytes(24).toString("hex"),
  API_KEY_PEPPER: randomBytes(24).toString("hex"),
  META_APP_SECRET: "smoke-app-secret",
  META_VERIFY_TOKEN: "smoke-verify-token",
  TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  META_API_BASE_URL: `http://127.0.0.1:${META_PORT}`,
  RUN_WORKERS: "false",
};

const metaCalls = [];
const fakeMeta = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    metaCalls.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
    res.setHeader("content-type", "application/json");
    if (req.url.includes("/messages")) return res.end(JSON.stringify({ messages: [{ id: `wamid.SMOKE${metaCalls.length}` }] }));
    if (req.url.includes("message_templates")) return res.end(JSON.stringify({ data: [{ id: "1", name: "hello", language: "en", status: "APPROVED", category: "MARKETING", components: [{ type: "BODY", text: "Hello {{1}}" }] }] }));
    res.end(JSON.stringify({ display_phone_number: "+1 555 0100", verified_name: "Smoke", quality_rating: "GREEN" }));
  });
});

const check = (cond, label) => {
  if (!cond) throw new Error(`FAILED: ${label}`);
  console.log(`ok - ${label}`);
};

function run(args, { wait = true } = {}) {
  const child = spawn(process.execPath, ["src/index.js", ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
  child.output = "";
  child.stdout.on("data", (d) => (child.output += d));
  child.stderr.on("data", (d) => (child.output += d));
  if (!wait) return child;
  return new Promise((resolve) => child.on("exit", (code) => resolve({ code, output: child.output })));
}

async function api(method, path, { token, body, headers = {} } = {}) {
  const res = await fetch(`http://127.0.0.1:${API_PORT}${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}), ...headers }, body: body ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined });
  return { status: res.status, json: await res.json().catch(() => null) };
}

const pglite = await PGlite.create();
const dbServer = new PGLiteSocketServer({ db: pglite, port: DB_PORT, host: "127.0.0.1" });
await dbServer.start();
await new Promise((r) => fakeMeta.listen(META_PORT, "127.0.0.1", r));
let server;
try {
  const m1 = await run(["migrate"]);
  check(m1.code === 0 && m1.output.includes("applied 2 migration(s)"), "migrate applies the schema");
  const m2 = await run(["migrate"]);
  check(m2.code === 0 && m2.output.includes("up to date"), "migrate is idempotent");

  server = run(["serve"], { wait: false });
  for (let i = 0; i < 50 && !server.output.includes("listening"); i++) await new Promise((r) => setTimeout(r, 100));
  check((await api("GET", "/ready")).status === 200, "server is ready with a database connection");

  const admin = env.ADMIN_TOKEN;
  const tenant = (await api("POST", "/admin/tenants", { token: admin, body: { name: "Smoke", status: "active" } })).json.tenant;
  check(tenant?.id?.startsWith("ten_"), "admin creates a tenant");
  const number = (await api("POST", `/admin/tenants/${tenant.id}/numbers`, { token: admin, body: { waba_id: "11111", phone_number_id: "22222", access_token: "EAAG-smoke" } })).json.number;
  check(number?.display_phone === "+1 555 0100", "admin connects a number verified via the Graph API");
  const key = (await api("POST", `/admin/tenants/${tenant.id}/api-keys`, { token: admin, body: { name: "smoke" } })).json.api_key.key;
  check((await api("POST", `/admin/tenants/${tenant.id}/balance`, { token: admin, body: { amount: 50 } })).json.balance === 50, "admin tops up credits");
  check((await api("POST", "/v1/templates/sync", { token: key, body: {} })).json.synced === 1, "tenant syncs templates");

  const sent = await api("POST", "/v1/messages", { token: key, headers: { "idempotency-key": "smoke-1" }, body: { to: "+923001234567", type: "template", template: { name: "hello", language: "en", variables: { 1: "World" } } } });
  check(sent.status === 202 && sent.json.message.status === "sent" && sent.json.message.credits === 10, "tenant sends a template message (credits held)");
  const sendCall = metaCalls.find((c) => c.url.endsWith("/22222/messages"));
  check(sendCall?.auth === "Bearer EAAG-smoke", "the stored token is decrypted for the Graph API call");

  const statusPayload = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "11111", changes: [{ field: "messages", value: { metadata: { phone_number_id: "22222" }, statuses: [{ id: sent.json.message.wamid, status: "failed", timestamp: "1761904800", errors: [{ code: 131026, title: "undeliverable" }] }] } }] }] });
  const sig = "sha256=" + createHmac("sha256", env.META_APP_SECRET).update(statusPayload).digest("hex");
  const wh = await api("POST", "/webhooks/meta", { body: statusPayload, headers: { "x-hub-signature-256": sig } });
  check(wh.status === 200 && wh.json.processed === 1, "signed Meta status webhook is processed");
  const msg = (await api("GET", `/v1/messages/${sent.json.message.id}`, { token: key })).json.message;
  check(msg.status === "failed" && msg.credits_refunded === true, "failed delivery is recorded and refunded");
  check((await api("GET", "/v1/wallet", { token: key })).json.balance === 50, "wallet balance restored");
  console.log("\nsmoke test passed");
} catch (err) {
  console.error(err.message);
  if (server) console.error("--- server output ---\n" + server.output);
  process.exitCode = 1;
} finally {
  server?.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 200));
  fakeMeta.close();
  await dbServer.stop();
  await pglite.close();
}
