import * as repo from "./db/repo.js";

const DAY = 24 * 60 * 60 * 1000;

/**
 * Background loops: due scheduled messages, stuck-send sweeping and retention
 * cleanup. Each loop waits for its previous run, so runs never overlap.
 */
export function startWorkers({ db, messaging, now = () => new Date(), log = () => {}, intervals = {} }) {
  const timers = [];
  const loop = (name, ms, fn) => {
    let running = false;
    const tick = async () => {
      if (running) return;
      running = true;
      try {
        const n = await fn();
        if (n) log({ level: "info", msg: `worker ${name}`, count: n });
      } catch (err) {
        log({ level: "error", msg: `worker ${name} failed`, error: err?.message });
      } finally {
        running = false;
      }
    };
    const timer = setInterval(tick, ms);
    timer.unref?.();
    timers.push(timer);
    return tick;
  };

  loop("scheduled", intervals.scheduled ?? 5_000, () => messaging.runScheduled());
  loop("stuck", intervals.stuck ?? 60_000, () => messaging.sweepStuck());
  loop("retention", intervals.retention ?? 60 * 60_000, async () => {
    const t = now().getTime();
    const keys = await repo.purgeIdempotencyKeys(db, new Date(t - DAY));
    const events = await repo.purgeWebhookEvents(db, new Date(t - 30 * DAY));
    return keys + events;
  });

  return { stop: () => timers.forEach(clearInterval) };
}
