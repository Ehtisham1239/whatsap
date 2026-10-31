import { test } from "node:test";
import assert from "node:assert/strict";
import { newId, hasPrefix, ID_PREFIXES } from "../../src/lib/ids.js";

test("newId returns prefix plus 20 base32 characters", () => {
  const id = newId(ID_PREFIXES.message);
  assert.match(id, /^msg_[0-9a-z]{20}$/);
  assert.ok(hasPrefix(id, "msg"));
  assert.ok(!hasPrefix(id, "ct"));
});

test("newId is deterministic for a controlled random source and unique otherwise", () => {
  const zeros = () => Buffer.alloc(20, 0);
  assert.equal(newId("ten", zeros), "ten_00000000000000000000");
  const ids = new Set(Array.from({ length: 1000 }, () => newId("ct")));
  assert.equal(ids.size, 1000);
});

test("newId rejects invalid prefixes", () => {
  for (const p of ["", "A", "x", "has_underscore", "toolongprefix"]) assert.throws(() => newId(p), TypeError);
});
