import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePhone, isValidStoredPhone, maskPhone } from "../../src/lib/phone.js";

test("normalizePhone accepts common international formats", () => {
  for (const input of ["+92 300 1234567", "0092-300-1234567", "+92 (300) 123-4567", "923001234567", 923001234567]) {
    assert.equal(normalizePhone(input), "923001234567", String(input));
  }
});

test("normalizePhone converts a national number only with a default country code", () => {
  assert.equal(normalizePhone("03001234567"), null);
  assert.equal(normalizePhone("03001234567", { defaultCountryCode: "92" }), "923001234567");
  assert.equal(normalizePhone("03001234567", { defaultCountryCode: "0" }), null);
});

test("normalizePhone rejects invalid input", () => {
  for (const input of [undefined, null, "", "  ", "abc", "+92 300 12a4567", "++923001234567", "92+3001234567", "1234567", "1234567890123456", "+0923001234567", {}]) {
    assert.equal(normalizePhone(input), null, String(input));
  }
});

test("length boundaries match the database check (8 to 15 digits)", () => {
  assert.equal(normalizePhone("12345678"), "12345678");
  assert.equal(normalizePhone("123456789012345"), "123456789012345");
  assert.equal(normalizePhone("1234567"), null);
  assert.equal(normalizePhone("1234567890123456"), null);
});

test("isValidStoredPhone and maskPhone", () => {
  assert.ok(isValidStoredPhone("923001234567"));
  assert.ok(!isValidStoredPhone("+923001234567"));
  assert.equal(maskPhone("923001234567"), "+92300•••4567");
  assert.equal(maskPhone("nope"), "invalid");
});
