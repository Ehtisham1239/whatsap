/**
 * In-memory token bucket per key. Suitable for a single instance; put a shared
 * limiter (e.g. at the edge) in front when running several instances.
 */
export function createRateLimiter({ capacity = 20, refillPerSecond = 10, now = () => Date.now(), maxKeys = 50_000 } = {}) {
  const buckets = new Map();
  return {
    /** Returns { ok, retryAfterSeconds }. */
    take(key, cost = 1) {
      const t = now();
      let b = buckets.get(key);
      if (!b) {
        if (buckets.size >= maxKeys) buckets.delete(buckets.keys().next().value);
        b = { tokens: capacity, at: t };
        buckets.set(key, b);
      }
      b.tokens = Math.min(capacity, b.tokens + ((t - b.at) / 1000) * refillPerSecond);
      b.at = t;
      if (b.tokens >= cost) {
        b.tokens -= cost;
        return { ok: true, retryAfterSeconds: 0 };
      }
      return { ok: false, retryAfterSeconds: Math.ceil((cost - b.tokens) / refillPerSecond) };
    },
  };
}
