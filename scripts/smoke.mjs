// End-to-end smoke test of the real entrypoint (src/index.js) with the
// production `pg` driver, against an in-process Postgres (PGlite over the wire
// protocol) and a local fake of the Graph API. Nothing external is contacted.
//   node scripts/smoke.mjs
import { createHmac } from "node:crypto";
import { checker, startStack } from "./harness.mjs";

const API_PORT = 58080;
const stack = await startStack({ apiPort: API_PORT });
const { env, metaCalls, run } = stack;
const check = checker();

async function api(method, path, { token, body, headers = {} } = {}) {
  const res = await fetch(`http://127.0.0.1:${API_PORT}${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}), ...headers }, body: body ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined });
  return { status: res.status, json: await res.json().catch(() => null) };
}

let server;
try {
  const m1 = await run(["migrate"]);
  check(m1.code === 0 && m1.output.includes("applied 5 migration(s)"), "migrate applies the schema");
  const m2 = await run(["migrate"]);
  check(m2.code === 0 && m2.output.includes("up to date"), "migrate is idempotent");

  server = await stack.serve();
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
  await stack.stop();
}
