import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { fromPglite } from "../../src/db/database.js";
import { migrate, splitSql } from "../../src/db/migrate.js";
import { MIGRATIONS_DIR } from "../helpers/db.js";

test("splitSql keeps nested dollar quotes intact", () => {
  const sql = "do $m$ begin perform x($j$ select 1; $j$); end $m$;\nselect 2;";
  assert.deepEqual(splitSql(sql), ["do $m$ begin perform x($j$ select 1; $j$); end $m$", "select 2"]);
});

test("splitSql keeps quoted semicolons, dollar bodies and drops comments", () => {
  const sql = "-- c1; \ncreate table a (x text default ';');\ncreate function f() returns int language sql as $$ select 1; $$;\n-- end";
  assert.deepEqual(splitSql(sql), ["create table a (x text default ';')", "create function f() returns int language sql as $$ select 1; $$"]);
});

test("migrate applies each file once and records it like production", async () => {
  const db = fromPglite(new PGlite());
  const logs = [];
  assert.deepEqual(await migrate(db, MIGRATIONS_DIR, { log: (l) => logs.push(l) }), ["0001_init.sql", "0002_enable_rls.sql", "0003_users_sessions.sql", "0004_broadcasts.sql", "0005_cron_job.sql"]);
  assert.deepEqual(await migrate(db, MIGRATIONS_DIR), []);
  const names = (await db.query("select name from schema_migrations order by name")).rows.map((r) => r.name);
  assert.deepEqual(names, ["0001_init.sql", "0002_enable_rls.sql", "0003_users_sessions.sql", "0004_broadcasts.sql", "0005_cron_job.sql"]);
  const rls = (await db.query("select count(*)::int as n from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity")).rows[0].n;
  assert.equal(rls, 0, "every public table has RLS enabled");
  await db.close();
});
