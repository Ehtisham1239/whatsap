// Vercel entry point: every request is rewritten here (see vercel.json).
// Services are created once per function instance and reused across requests.
import { waitUntil } from "@vercel/functions";
import { loadConfig } from "../src/config.js";
import { createPgDatabase } from "../src/db/database.js";
import { createApp } from "../src/http/app.js";
import { buildServices } from "../src/index.js";
import { runMaintenance } from "../src/worker.js";

const log = (entry) => console.log(JSON.stringify({ time: new Date().toISOString(), ...entry }));
let ready;

function init() {
  let config;
  try {
    config = loadConfig({ TRUST_PROXY: "true", RUN_WORKERS: "false", DATABASE_POOL_MAX: "3", ...process.env });
  } catch (err) {
    // Report which settings are missing (names only, never values).
    return { error: err.message };
  }
  const db = createPgDatabase(config.databaseUrl, { ssl: config.databaseSsl, max: config.databasePoolMax });
  const services = buildServices(config, db);
  const handle = createApp(services, { ...config, runMaintenance: () => runMaintenance(services) }, { log });
  return { handle, services };
}

export default async function handler(req, res) {
  ready ??= init();
  if (ready.error) {
    res.writeHead(503, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    res.end(`Service is not configured yet.\n\n${ready.error}\n`);
    return;
  }
  await ready.handle(req, res);
  // Let tenant webhook deliveries finish after the response is sent.
  waitUntil(ready.services.broadcasts.drain().then(() => ready.services.notifier.drain()));
}
