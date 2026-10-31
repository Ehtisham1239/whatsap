/** Tiny method + path router: "/v1/messages/:id" style patterns. */
export function createRouter() {
  const routes = [];
  const add = (method, pattern, handler) => {
    const names = [];
    const re = new RegExp(
      "^" +
        pattern.replace(/\/:([a-zA-Z_]+)/g, (_, n) => {
          names.push(n);
          return "/([^/]+)";
        }) +
        "/?$",
    );
    routes.push({ method, re, names, handler });
  };
  return {
    get: (p, h) => add("GET", p, h),
    post: (p, h) => add("POST", p, h),
    patch: (p, h) => add("PATCH", p, h),
    delete: (p, h) => add("DELETE", p, h),
    /** Returns { handler, params } or { allowed: [...] } when only the method differs, or null. */
    match(method, path) {
      const allowed = [];
      for (const r of routes) {
        const m = r.re.exec(path);
        if (!m) continue;
        if (r.method !== method) {
          allowed.push(r.method);
          continue;
        }
        const params = {};
        r.names.forEach((n, i) => {
          params[n] = decodeURIComponent(m[i + 1]);
        });
        return { handler: r.handler, params };
      }
      return allowed.length ? { allowed } : null;
    },
  };
}
