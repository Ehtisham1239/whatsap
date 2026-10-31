import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Applies db/migrations/*.sql in name order, each in its own transaction, and
 * records it in public.schema_migrations (same convention as production, where
 * 0001_init.sql and 0002_enable_rls.sql are already recorded).
 */
export async function migrate(db, dir, { log = () => {} } = {}) {
  await db.query("create table if not exists public.schema_migrations (name text primary key, applied_at timestamptz not null default now())");
  const done = new Set((await db.query("select name from public.schema_migrations")).rows.map((r) => r.name));
  const files = (await readdir(dir)).filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)).sort();
  const applied = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = await readFile(join(dir, file), "utf8");
    await db.tx(async (q) => {
      for (const stmt of splitSql(sql)) await q.query(stmt);
      await q.query("insert into public.schema_migrations (name) values ($1)", [file]);
    });
    log(`applied ${file}`);
    applied.push(file);
  }
  return applied;
}

/** Splits on top-level semicolons, ignoring those inside '...' strings, $$ bodies and -- comments. */
export function splitSql(sql) {
  const out = [];
  let cur = "";
  let dollar = null;
  let quoted = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (!dollar && ch === "'") {
      quoted = !quoted;
      cur += ch;
      continue;
    }
    if (quoted) {
      cur += ch;
      continue;
    }
    if (!dollar && ch === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end;
      cur += "\n";
      continue;
    }
    if (ch === "$") {
      const m = /^\$[a-zA-Z_]*\$/.exec(sql.slice(i));
      if (m) {
        if (!dollar) dollar = m[0];
        else if (dollar === m[0]) dollar = null;
        cur += m[0];
        i += m[0].length - 1;
        continue;
      }
    }
    if (ch === ";" && !dollar) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
