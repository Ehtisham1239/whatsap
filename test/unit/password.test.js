import { test } from "node:test";
import assert from "node:assert/strict";
import { hashPassword, normalizeEmail, passwordProblem, verifyPassword } from "../../src/lib/password.js";

const FAST = { N: 1024, r: 8, p: 1 };

test("hashPassword produces salted scrypt hashes that verify", async () => {
  const a = await hashPassword("correct horse battery", FAST);
  const b = await hashPassword("correct horse battery", FAST);
  assert.match(a, /^scrypt\$1024\$8\$1\$[\w-]+\$[\w-]+$/);
  assert.notEqual(a, b, "salted");
  assert.equal(await verifyPassword("correct horse battery", a), true);
  assert.equal(await verifyPassword("correct horse batterY", a), false);
  assert.equal(await verifyPassword("", a), false);
});

test("default parameters are strong enough", async () => {
  assert.match(await hashPassword("another long secret"), /^scrypt\$16384\$8\$1\$/);
});

test("verifyPassword rejects malformed or abusive hashes", async () => {
  assert.equal(await verifyPassword("x", "bcrypt$..."), false);
  assert.equal(await verifyPassword("x", null), false);
  assert.equal(await verifyPassword("x", "scrypt$99999999$8$1$c2FsdA$aGFzaA"), false);
  assert.equal(await verifyPassword(undefined, await hashPassword("abcdefghijk", FAST)), false);
});

test("unicode passwords are normalised", async () => {
  const h = await hashPassword("ﬁsh and chips!", FAST);
  assert.equal(await verifyPassword("fish and chips!", h), true);
});

test("passwordProblem", () => {
  assert.equal(passwordProblem("short"), "Password must be at least 10 characters");
  assert.equal(passwordProblem("x".repeat(201)), "Password must be at most 200 characters");
  assert.equal(passwordProblem("aaaaaaaaaaaa"), "Password is too repetitive");
  assert.match(passwordProblem("my password 1"), /too common/);
  assert.match(passwordProblem("ehtisham-secure-9", { email: "ehtisham@example.com" }), /name or email/);
  assert.match(passwordProblem("Ali Khan rocks 99", { name: "Ali Khan" }), /name or email/);
  assert.equal(passwordProblem("tulip-orbit-cedar-42", { email: "ali@example.com", name: "Ali" }), null);
  assert.equal(passwordProblem(undefined), "Password is required");
});

test("normalizeEmail", () => {
  assert.equal(normalizeEmail("  Ali@Example.COM "), "ali@example.com");
  for (const v of ["", "ali", "ali@", "a b@c.de", "a@b", null, 5]) assert.equal(normalizeEmail(v), null, String(v));
});
