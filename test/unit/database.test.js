import { test } from "node:test";
import assert from "node:assert/strict";
import { createPgDatabase, fromPgPool } from "../../src/db/database.js";

function fakePool() {
  const log = [];
  const client = {
    query: async (sql) => {
      log.push(sql);
      if (sql === "fail") throw new Error("query failed");
      return { rows: [{ ok: 1 }] };
    },
    release: () => log.push("release"),
  };
  return { log, pool: { connect: async () => client, query: async (sql) => (log.push(`pool:${sql}`), { rows: [] }), end: async () => log.push("end") } };
}

test("tx commits on success and releases the client", async () => {
  const { log, pool } = fakePool();
  const db = fromPgPool(pool);
  const r = await db.tx(async (q) => (await q.query("select 1")).rows[0].ok);
  assert.equal(r, 1);
  assert.deepEqual(log, ["begin", "select 1", "commit", "release"]);
  await db.query("select 2");
  await db.close();
  assert.deepEqual(log.slice(-2), ["pool:select 2", "end"]);
});

test("tx rolls back and rethrows on failure, still releasing", async () => {
  const { log, pool } = fakePool();
  await assert.rejects(fromPgPool(pool).tx((q) => q.query("fail")), /query failed/);
  assert.deepEqual(log, ["begin", "fail", "rollback", "release"]);
});

test("createPgDatabase requires a connection string", () => {
  assert.throws(() => createPgDatabase(""), /DATABASE_URL/);
});
