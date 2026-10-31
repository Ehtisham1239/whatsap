// Tiny DOM helpers. Text is always set with textContent, never innerHTML,
// so message content cannot inject markup.
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "value") el.value = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);

export function clear(el) {
  while (el.firstChild) el.firstChild.remove();
  return el;
}

let toastTimer;
export function toast(text, kind = "info") {
  const el = $("#toast");
  if (!el) return;
  el.textContent = text;
  el.className = `toast show ${kind}`;
  el.setAttribute("role", kind === "error" ? "alert" : "status");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = "toast"), 4000);
}

/** Fetch wrapper: JSON in/out, bearer token, throws the API error body. */
export function createClient(getToken, onUnauthorized) {
  async function request(method, path, body, { raw = false, headers = {} } = {}) {
    const res = await fetch(path, {
      method,
      // Cookie sessions need the X-Requested-With header on writes (CSRF check).
      headers: { ...(getToken() ? { authorization: `Bearer ${getToken()}` } : { "x-requested-with": "fetch" }), ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
      credentials: "same-origin",
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401 && onUnauthorized) onUnauthorized();
    if (raw && res.ok) return res;
    const json = await res.json().catch(() => null);
    if (!res.ok) throw json ?? { error: { message: `HTTP ${res.status}` } };
    return json;
  }
  return {
    get: (p, o) => request("GET", p, undefined, o),
    post: (p, b, o) => request("POST", p, b ?? {}, o),
    patch: (p, b) => request("PATCH", p, b ?? {}),
    del: (p) => request("DELETE", p),
  };
}

/** sessionStorage wrapper that never throws (private mode, disabled storage). */
export const session = {
  get(k) {
    try {
      return sessionStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      if (v === null) sessionStorage.removeItem(k);
      else sessionStorage.setItem(k, v);
    } catch {}
  },
};
