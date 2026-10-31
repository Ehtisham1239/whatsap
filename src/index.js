import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { createPgDatabase } from "./db/database.js";
import { migrate } from "./db/migrate.js";
import { createApp } from "./http/app.js";
import { createMetaClient } from "./meta/client.js";
import { createAccountService } from "./services/accounts.js";
import { createInboundService } from "./services/inbound.js";
import { createMediaService } from "./services/media.js";
import { createMessagingService } from "./services/messaging.js";
import { createNotifier } from "./services/notifier.js";
import { createTemplateService } from "./services/templates.js";
import { startWorkers } from "./worker.js";

const log = (entry) => console.log(JSON.stringify({ time: new Date().toISOString(), ...entry }));

export function buildServices(config, db, { meta = createMetaClient({ graphVersion: config.graphVersion, baseUrl: config.metaBaseUrl }), fetch = globalThis.fetch } = {}) {
  const notifier = createNotifier({ db, fetch, log });
  const common = { db, meta, encryptionKey: config.encryptionKey };
  return {
    db,
    notifier,
    accounts: createAccountService({ ...common, apiKeyPepper: config.apiKeyPepper }),
    messaging: createMessagingService({ ...common, prices: config.prices, notifier, defaultCountryCode: config.defaultCountryCode, log }),
    inbound: createInboundService({ db, appSecret: config.metaAppSecret, notifier, log }),
    templates: createTemplateService(common),
    media: createMediaService(common),
  };
}

async function main() {
  const command = process.argv[2] ?? "serve";
  const config = loadConfig();
  const db = createPgDatabase(config.databaseUrl, { ssl: config.databaseSsl, max: config.databasePoolMax });

  if (command === "migrate") {
    const applied = await migrate(db, fileURLToPath(new URL("../db/migrations", import.meta.url)), { log: (m) => log({ level: "info", msg: m }) });
    log({ level: "info", msg: applied.length ? `applied ${applied.length} migration(s)` : "database is up to date" });
    await db.close();
    return;
  }
  if (command !== "serve") throw new Error(`unknown command ${command}; use serve or migrate`);

  const services = buildServices(config, db);
  const server = createServer(createApp(services, config, { log }));
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  const workers = config.runWorkers ? startWorkers({ db, messaging: services.messaging, log }) : { stop() {} };
  server.listen(config.port, () => log({ level: "info", msg: "listening", port: config.port }));

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    log({ level: "info", msg: "shutting down", signal });
    workers.stop();
    server.close();
    await services.notifier.drain();
    await db.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
