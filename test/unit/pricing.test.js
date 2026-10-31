import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PRICES, loadPrices, priceOutbound } from "../../src/lib/pricing.js";

const now = new Date("2026-10-31T10:00:00Z");
const open = { expires_at: new Date(now.getTime() + 1000), source: "user" };
const closed = { expires_at: new Date(now.getTime() - 1000), source: "user" };
const ctwa = { expires_at: new Date(now.getTime() + 1000), source: "ctwa" };

test("custom messages are free service messages", () => {
  assert.deepEqual(priceOutbound({ mode: "custom", window: open, now }), { category: "service", credits: 0 });
});

test("templates outside the window are charged by category", () => {
  assert.deepEqual(priceOutbound({ mode: "template", templateCategory: "marketing", window: closed, now }), { category: "marketing", credits: 10 });
  assert.deepEqual(priceOutbound({ mode: "template", templateCategory: "utility", window: null, now }), { category: "utility", credits: 4 });
  assert.deepEqual(priceOutbound({ mode: "template", templateCategory: "authentication", window: closed, now }), { category: "authentication", credits: 4 });
});

test("utility templates are free inside an open service window; marketing is not", () => {
  assert.equal(priceOutbound({ mode: "template", templateCategory: "utility", window: open, now }).credits, 0);
  assert.equal(priceOutbound({ mode: "template", templateCategory: "marketing", window: open, now }).credits, 10);
});

test("everything is free inside an open CTWA window", () => {
  assert.equal(priceOutbound({ mode: "template", templateCategory: "marketing", window: ctwa, now }).credits, 0);
});

test("invalid inputs throw", () => {
  assert.throws(() => priceOutbound({ mode: "note", window: open, now }), TypeError);
  assert.throws(() => priceOutbound({ mode: "template", templateCategory: "service", window: open, now }), TypeError);
  assert.throws(() => priceOutbound({ mode: "template", templateCategory: "bogus", window: open, now }), TypeError);
});

test("loadPrices applies integer overrides and rejects others", () => {
  assert.deepEqual(loadPrices({}), DEFAULT_PRICES);
  assert.equal(loadPrices({ PRICE_MARKETING: "25" }).marketing, 25);
  assert.equal(loadPrices({ PRICE_MARKETING: "" }).marketing, 10);
  assert.throws(() => loadPrices({ PRICE_UTILITY: "-1" }), /non-negative integer/);
  assert.throws(() => loadPrices({ PRICE_UTILITY: "1.5" }), /non-negative integer/);
});
