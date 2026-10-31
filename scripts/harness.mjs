// Starts the real server (src/index.js, production `pg` driver) against an
// in-process Postgres served over the wire protocol, plus a local fake of the
// Graph API. Used by smoke.mjs and e2e-ui.mjs. Nothing external is contacted.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

export async function startStack({ dbPort = 55432, apiPort = 58080, metaPort = 59090 } = {}) {
  const env = {
    ...process.env,
    PORT: String(apiPort),
    DATABASE_URL: `postgresql://postgres:postgres@127.0.0.1:${dbPort}/postgres`,
    DATABASE_SSL: "false",
    DATABASE_POOL_MAX: "1", // the PGlite socket server accepts one connection at a time
    ADMIN_TOKEN: randomBytes(24).toString("hex"),
    API_KEY_PEPPER: randomBytes(24).toString("hex"),
    META_APP_SECRET: "smoke-app-secret",
    META_VERIFY_TOKEN: "smoke-verify-token",
    TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    META_API_BASE_URL: `http://127.0.0.1:${metaPort}`,
    RUN_WORKERS: "false",
    COOKIE_SECURE: "false", // plain http on localhost
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

  const pglite = await PGlite.create();
  const dbServer = new PGLiteSocketServer({ db: pglite, port: dbPort, host: "127.0.0.1" });
  await dbServer.start();
  await new Promise((r) => fakeMeta.listen(metaPort, "127.0.0.1", r));

  const run = (args, { wait = true } = {}) => {
    const child = spawn(process.execPath, ["src/index.js", ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    child.output = "";
    child.stdout.on("data", (d) => (child.output += d));
    child.stderr.on("data", (d) => (child.output += d));
    if (!wait) return child;
    return new Promise((resolve) => child.on("exit", (code) => resolve({ code, output: child.output })));
  };

  let server = null;
  return {
    env,
    metaCalls,
    run,
    baseUrl: `http://127.0.0.1:${apiPort}`,
    async serve() {
      server = run(["serve"], { wait: false });
      for (let i = 0; i < 50 && !server.output.includes("listening"); i++) await new Promise((r) => setTimeout(r, 100));
      return server;
    },
    get serverOutput() {
      return server?.output ?? "";
    },
    async stop() {
      server?.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 200));
      fakeMeta.close();
      await dbServer.stop();
      await pglite.close();
    },
  };
}

export function checker() {
  return (cond, label) => {
    if (!cond) throw new Error(`FAILED: ${label}`);
    console.log(`ok - ${label}`);
  };
}
