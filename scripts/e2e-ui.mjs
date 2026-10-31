// Browser journey through the dashboard in Chromium (Playwright), against the
// real server from harness.mjs.   node scripts/e2e-ui.mjs [screenshot-dir]
import { createHmac } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { checker, startStack } from "./harness.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const shots = process.argv[2] || null;
if (shots) mkdirSync(shots, { recursive: true });
const check = checker();
const stack = await startStack({ dbPort: 55433, apiPort: 58081, metaPort: 59091 });
const base = stack.baseUrl;
const admin = (method, path, body) =>
  fetch(base + path, { method, headers: { authorization: `Bearer ${stack.env.ADMIN_TOKEN}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());
const inbound = async (id, text) => {
  const payload = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "11111", changes: [{ field: "messages", value: { metadata: { phone_number_id: "22222" }, contacts: [{ wa_id: "923001234567", profile: { name: "Ali Khan" } }], messages: [{ from: "923001234567", id, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: text } }] } }] }] });
  const sig = "sha256=" + createHmac("sha256", stack.env.META_APP_SECRET).update(payload).digest("hex");
  return fetch(`${base}/webhooks/meta`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": sig }, body: payload });
};

let browser;
const problems = [];
try {
  check((await stack.run(["migrate"])).code === 0, "database migrated");
  await stack.serve();
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  // HTTP error statuses are expected in this journey (signed-out probes, bad passwords, the CSRF check);
  // anything else logged as an error (JS exceptions, CSP violations) fails the run.
  page.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && problems.push(m.text()));
  page.on("pageerror", (e) => problems.push(e.message));
  page.on("dialog", (d) => d.accept());
  const shot = (name) => shots && page.screenshot({ path: `${shots}/${name}.png` });

  // sign up
  await page.goto(`${base}/app`);
  await page.waitForURL(/\/login$/);
  check(true, "signed-out visitors are sent to /login");
  await shot("01-login");
  await page.click("text=Create an account");
  await page.fill('input[name="business_name"]', "Acme Traders");
  await page.fill('input[name="name"]', "Sara Ahmed");
  await page.fill('input[name="email"]', "sara@acme.pk");
  await page.fill('input[name="password"]', "short");
  await page.click('button[type="submit"]');
  await page.waitForSelector("#form-error:has-text('at least 10')");
  check(await page.getAttribute('input[name="password"]', "aria-invalid") === "true", "weak password is rejected inline");
  await shot("02-signup");
  await page.fill('input[name="password"]', "tulip-orbit-cedar-42");
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/app/);
  await page.waitForSelector("text=Welcome, Sara");
  check(await page.isVisible("#banner:has-text('not connected')"), "new workspace lands on the dashboard with a setup banner");
  await shot("03-dashboard-new");

  // operator connects a number and adds credits
  const tenantId = (await admin("GET", "/admin/tenants")).data[0].id;
  await admin("POST", `/admin/tenants/${tenantId}/numbers`, { waba_id: "11111", phone_number_id: "22222", access_token: "EAAG-ui" });
  await admin("POST", `/admin/tenants/${tenantId}/balance`, { amount: 100 });
  await admin("PATCH", `/admin/tenants/${tenantId}`, { status: "active" });

  // templates
  await page.goto(`${base}/app#/templates`);
  await page.click("text=Sync from WhatsApp");
  await page.waitForSelector("td:has-text('hello')");
  check(true, "templates sync from WhatsApp and are listed");
  await page.waitForSelector("#banner.hidden", { state: "attached" });
  check(true, "setup banner disappears once a number is connected");

  // new conversation with a template
  await page.click("#new-message");
  await page.fill("#new-to", "0300 1234567");
  await page.selectOption(".modal select", { label: "hello (en, marketing)" });
  await page.fill('.modal input[name="1"]', "Ali");
  await page.click(".modal button:has-text('Send template')");
  await page.waitForSelector(".bubble.out:has-text('Hello Ali')");
  check(await page.isVisible(".bubble.out .meta:has-text('10 cr')"), "template sent from the dialog; thread shows the charge");
  check((await page.textContent("#balance")).startsWith("90"), "wallet balance updates");

  // inbound reply arrives and is shown as text (no HTML injection)
  await inbound("wamid.UI1", '<img src=x onerror="window.__xss=1"> Thanks! When will it arrive?');
  await page.waitForSelector(".bubble:not(.out):has-text('When will it arrive?')", { timeout: 15000 });
  check((await page.locator(".messages img").count()) === 0 && !(await page.evaluate(() => window.__xss)), "inbound message appears via polling and HTML is not rendered");
  check(await page.isVisible(".window:has-text('Reply window open')"), "reply window opens after the customer writes");

  // free-form reply and an internal note
  await page.fill("#reply-text", "It ships today 🚚");
  await page.click(".composer button:has-text('Send')");
  await page.waitForSelector(".bubble.out:has-text('It ships today')");
  await page.fill('input[aria-label="Internal note"]', "VIP customer");
  await page.click("button:has-text('Add note')");
  await page.waitForSelector(".bubble.note:has-text('VIP customer')");
  check(true, "free-form reply and internal note added");
  await shot("04-inbox");

  // resolve
  await page.click(".thread-head button:has-text('Resolve')");
  await page.waitForSelector(".thread-head .badge:has-text('resolved')");
  check(true, "conversation resolved");

  // team + developers
  await page.goto(`${base}/app#/team`);
  await page.fill('#view-team input[name="name"]', "Agent Bilal");
  await page.fill('#view-team input[name="email"]', "bilal@acme.pk");
  await page.fill('#view-team input[name="password"]', "river-stone-77x");
  await page.click("#view-team button:has-text('Add teammate')");
  await page.waitForSelector("td:has-text('bilal@acme.pk')");
  check(true, "teammate added");
  await page.goto(`${base}/app#/developers`);
  await page.fill('#view-developers input[name="name"]', "CRM");
  await page.click("#view-developers button:has-text('Create API key')");
  const key = (await page.textContent("[data-secret]", { timeout: 10000 })).trim();
  const viaKey = await fetch(`${base}/v1/numbers`, { headers: { authorization: `Bearer ${key}` } });
  check(key.startsWith("wa_live_") && viaKey.status === 200, "API key created in the dashboard works against the API");
  await shot("05-developers");

  // dashboard numbers
  await page.goto(`${base}/app#/dashboard`);
  await page.waitForSelector(".stat:has-text('Messages sent') .v:has-text('2')");
  check(true, "dashboard stats count sent messages");
  await shot("06-dashboard");

  // broadcast from pasted CSV, with an invalid row fixed before sending
  await page.goto(`${base}/app#/broadcasts`);
  await page.fill('#view-broadcasts input[name="name"]', "Launch offer");
  await page.selectOption('#view-broadcasts select[name="template"]', { label: "hello (en, marketing)" });
  await page.fill('#view-broadcasts textarea[name="csv"]', "phone,1\n+923005550001,Asad\n12345,Bad");
  await page.waitForSelector("#view-broadcasts .error-text:has-text('Row 3')");
  check(await page.isDisabled("#view-broadcasts button:has-text('Send broadcast')"), "broadcast form blocks invalid CSV rows");
  await page.fill('#view-broadcasts textarea[name="csv"]', "phone,1\n+923005550001,Asad\n0300 5550002,Hina");
  await page.click("#view-broadcasts button:has-text('Send broadcast')");
  await page.waitForSelector(".toast:has-text('2 message(s)')");
  let completed = false;
  for (let i = 0; i < 10 && !completed; i++) {
    await page.waitForTimeout(300);
    await page.reload();
    await page.waitForSelector("#view-broadcasts td:has-text('Launch offer')");
    completed = await page.isVisible("#view-broadcasts .badge:has-text('completed')");
  }
  check(completed && stack.metaCalls.filter((c) => c.body.includes("Hina") || c.body.includes("Asad")).length === 2, "broadcast sent to every CSV recipient");
  await shot("09-broadcasts");

  // change password, sign out, sign in again; agent sees restricted pages
  await page.goto(`${base}/app#/settings`);
  await page.fill('input[name="current_password"]', "tulip-orbit-cedar-42");
  await page.fill('input[name="new_password"]', "maple-quartz-88");
  await page.click("button:has-text('Change password')");
  await page.waitForSelector(".toast:has-text('Password changed')");
  await page.click("#signout");
  await page.waitForURL(/\/login$/);
  await page.fill('input[name="email"]', "sara@acme.pk");
  await page.fill('input[name="password"]', "tulip-orbit-cedar-42");
  await page.click('button[type="submit"]');
  await page.waitForSelector("#form-error:has-text('incorrect')");
  await page.fill('input[name="password"]', "maple-quartz-88");
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/app/);
  check(true, "password change, sign-out and sign-in work");

  const agent = await browser.newPage({ viewport: { width: 390, height: 844 } });
  agent.on("pageerror", (e) => problems.push(e.message));
  await agent.goto(`${base}/login`);
  if (shots) await agent.screenshot({ path: `${shots}/07-login-mobile.png` });
  await agent.fill('input[name="email"]', "bilal@acme.pk");
  await agent.fill('input[name="password"]', "river-stone-77x");
  await agent.click('button[type="submit"]');
  await agent.waitForURL(/\/app/);
  await agent.goto(`${base}/app#/developers`);
  await agent.waitForSelector("text=Only workspace owners and admins");
  check(true, "agents cannot manage API keys");
  await agent.goto(`${base}/app#/inbox`);
  await agent.click(".tabs button:has-text('All')");
  await agent.click(".conv");
  await agent.waitForSelector(".bubble");
  const overflow = await agent.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  check(!overflow, "mobile inbox has no horizontal scroll");
  if (shots) await agent.screenshot({ path: `${shots}/08-inbox-mobile.png` });

  // CSRF: a cross-site form post is refused
  const csrf = await page.evaluate(() => fetch("/v1/conversations", { method: "GET" }).then(() => fetch("/v1/users", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).then((r) => r.status));
  check(csrf === 403, "cookie writes without the CSRF header are refused");

  check(problems.length === 0, `no console errors or CSP violations${problems.length ? `: ${problems.join(" | ")}` : ""}`);
  console.log("\nUI journey passed");
} catch (err) {
  console.error(err.message);
  console.error("--- server output (tail) ---\n" + stack.serverOutput.split("\n").slice(-15).join("\n"));
  if (problems.length) console.error("--- browser problems ---\n" + problems.join("\n"));
  process.exitCode = 1;
} finally {
  await browser?.close();
  await stack.stop();
}
