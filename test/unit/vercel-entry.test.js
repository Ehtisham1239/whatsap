import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

test("the Vercel entry reports missing settings by name without crashing", async () => {
  const saved = { ...process.env };
  for (const k of ["DATABASE_URL", "ADMIN_TOKEN", "API_KEY_PEPPER", "TOKEN_ENCRYPTION_KEY"]) delete process.env[k];
  const { default: handler } = await import("../../api/index.js");
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const res = await fetch(`http://127.0.0.1:${server.address().port}/health`);
  const text = await res.text();
  await new Promise((r) => server.close(r));
  process.env = saved;
  assert.equal(res.status, 503);
  assert.match(text, /DATABASE_URL/);
  assert.match(text, /TOKEN_ENCRYPTION_KEY/);
});
