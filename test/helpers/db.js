import { PGlite } from "@electric-sql/pglite";
import { fileURLToPath } from "node:url";
import { fromPglite } from "../../src/db/database.js";
import { migrate } from "../../src/db/migrate.js";

export const MIGRATIONS_DIR = fileURLToPath(new URL("../../db/migrations", import.meta.url));

const TABLES = [
  "user_sessions", "users", "broadcasts",
  "messages", "credit_ledger", "idempotency_keys", "webhook_events", "webhook_endpoints", "conversation_windows",
  "conversations", "templates", "api_keys", "contacts", "waba_connections", "wallets", "tenants",
];

/** One in-process Postgres per test file, migrated with the real schema. */
export async function createTestDb() {
  const db = fromPglite(new PGlite());
  await migrate(db, MIGRATIONS_DIR);
  return {
    db,
    reset: () => db.query(`truncate ${TABLES.join(", ")} cascade`),
    close: () => db.close(),
  };
}
