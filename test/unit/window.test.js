import { test } from "node:test";
import assert from "node:assert/strict";
import { isWindowOpen, nextWindow, windowExpiry } from "../../src/lib/window.js";

const t0 = new Date("2026-10-31T10:00:00Z");
const h = (n) => new Date(t0.getTime() + n * 3600_000);

test("service window lasts 24 hours and CTWA window 72 hours", () => {
  assert.deepEqual(windowExpiry(t0), h(24));
  assert.deepEqual(windowExpiry(t0, "ctwa"), h(72));
});

test("isWindowOpen is exclusive at the expiry instant", () => {
  const w = { expires_at: h(24) };
  assert.equal(isWindowOpen(w, h(23.99)), true);
  assert.equal(isWindowOpen(w, h(24)), false);
  assert.equal(isWindowOpen(null, t0), false);
});

test("nextWindow opens, extends, and never shortens a CTWA window", () => {
  const first = nextWindow(null, t0, "user");
  assert.deepEqual(first, { last_inbound_at: t0, expires_at: h(24), source: "user" });
  const extended = nextWindow(first, h(5), "user");
  assert.deepEqual(extended.expires_at, h(29));
  const ctwa = nextWindow(null, t0, "ctwa");
  const after = nextWindow(ctwa, h(1), "user");
  assert.deepEqual(after.expires_at, h(72));
  assert.equal(after.source, "ctwa");
  assert.deepEqual(after.last_inbound_at, h(1));
});

test("nextWindow ignores an older out-of-order inbound for last_inbound_at", () => {
  const w = nextWindow(null, h(5));
  const late = nextWindow(w, h(1));
  assert.deepEqual(late.last_inbound_at, h(5));
  assert.deepEqual(late.expires_at, h(29));
});

test("invalid dates throw", () => {
  assert.throws(() => windowExpiry("not a date"), TypeError);
});
