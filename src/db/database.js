import pg from "pg";

/**
 * Small database facade shared by node-postgres (production) and PGlite (tests):
 *   db.query(sql, params) -> { rows }
 *   db.tx(async (q) => ...)  runs fn in one transaction; q has the same query().
 */
export function fromPgPool(pool) {
  return {
    query: (sql, params) => pool.query(sql, params),
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const result = await fn({ query: (sql, params) => client.query(sql, params) });
        await client.query("commit");
        return result;
      } catch (err) {
        await client.query("rollback").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

export function fromPglite(pglite) {
  return {
    query: (sql, params) => pglite.query(sql, params),
    tx: (fn) => pglite.transaction((t) => fn({ query: (sql, params) => t.query(sql, params) })),
    close: () => pglite.close(),
  };
}

export function createPgDatabase(connectionString, { max = 10, ssl } = {}) {
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  const pool = new pg.Pool({ connectionString, max, ssl, application_name: "wa-platform" });
  pool.on("error", (err) => console.error(JSON.stringify({ level: "error", msg: "pg pool error", error: err.message })));
  return fromPgPool(pool);
}
