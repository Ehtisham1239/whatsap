import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { startWorkers } from "../../src/worker.js";

test("workers tick on their intervals, never overlap, and stop", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const calls = { scheduled: 0, stuck: 0, purged: 0 };
    let release;
    const messaging = {
      runScheduled: () => {
        calls.scheduled++;
        return new Promise((r) => (release = r));
      },
      sweepStuck: async () => (calls.stuck++, 0),
    };
    const db = { query: async () => (calls.purged++, { rowCount: 0 }) };
    const logs = [];
    const w = startWorkers({ db, messaging, log: (l) => logs.push(l), intervals: { scheduled: 10, stuck: 20, retention: 40 } });
    mock.timers.tick(10);
    mock.timers.tick(10);
    assert.equal(calls.scheduled, 1, "second tick skipped while the first runs");
    release(3);
    await new Promise((r) => setImmediate(r));
    mock.timers.tick(10);
    assert.equal(calls.scheduled, 2);
    assert.ok(calls.stuck >= 1);
    mock.timers.tick(10);
    await new Promise((r) => setImmediate(r));
    assert.equal(calls.purged, 3, "idempotency keys, webhook events and expired sessions purged");
    assert.ok(logs.some((l) => l.msg === "worker scheduled" && l.count === 3));
    w.stop();
    const before = calls.scheduled;
    mock.timers.tick(100);
    assert.equal(calls.scheduled, before);
  } finally {
    mock.timers.reset();
  }
});

test("worker errors are logged, not thrown", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const logs = [];
    const w = startWorkers({
      db: { query: async () => ({ rowCount: 0 }) },
      messaging: { runScheduled: async () => { throw new Error("boom"); }, sweepStuck: async () => 0 },
      log: (l) => logs.push(l),
      intervals: { scheduled: 10, stuck: 1000, retention: 1000 },
    });
    mock.timers.tick(10);
    await new Promise((r) => setImmediate(r));
    assert.ok(logs.some((l) => l.msg === "worker scheduled failed" && l.error === "boom"));
    w.stop();
  } finally {
    mock.timers.reset();
  }
});
