import { $, clear, createClient, h, session, toast } from "./dom.js";
import { errorMessage, formatCredits, formatDateTime } from "./format.js";

const TOKEN_KEY = "wa.adminToken";
const api = createClient(() => session.get(TOKEN_KEY), () => signOut("Your session ended. Sign in again."));
const STATUSES = ["trial", "active", "pending_activation", "suspended", "cancelled"];
const EVENTS = ["message.received", "message.status", "contact.opted_out", "contact.opted_in", "template.status"];

$("#signin-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  session.set(TOKEN_KEY, $("#admin-token").value.trim());
  $("#signin-error").textContent = "";
  try {
    await api.get("/admin/tenants?limit=1");
    $("#admin-token").value = "";
    start();
  } catch (err) {
    session.set(TOKEN_KEY, null);
    $("#signin-error").textContent = errorMessage(err);
  }
});
$("#signout").addEventListener("click", () => signOut());

function signOut(message) {
  session.set(TOKEN_KEY, null);
  $("#app").classList.add("hidden");
  $("#signin").classList.remove("hidden");
  if (message) $("#signin-error").textContent = message;
}

function start() {
  $("#signin").classList.add("hidden");
  $("#app").classList.remove("hidden");
  route();
}
window.addEventListener("hashchange", route);
if (session.get(TOKEN_KEY)) start();

function route() {
  const m = /^#\/tenants\/(ten_[0-9a-z]+)$/.exec(location.hash);
  if (m) renderTenant(m[1]).catch(fail);
  else renderTenants().catch(fail);
}
function fail(err) {
  toast(errorMessage(err), "error");
}

/** Runs an action with the button disabled; toasts errors; returns the result or null. */
async function act(button, fn, success) {
  if (button) button.disabled = true;
  try {
    const r = await fn();
    if (success) toast(success);
    return r;
  } catch (err) {
    toast(errorMessage(err), "error");
    return null;
  } finally {
    if (button) button.disabled = false;
  }
}

function formData(form) {
  const out = {};
  for (const el of form.elements) if (el.name) out[el.name] = el.type === "checkbox" ? el.checked : el.value.trim();
  return out;
}

function secretBox(title, value, note) {
  const box = h("div", { class: "secret-box", role: "alert" }, h("b", {}, title), h("div", { class: "mono", "data-secret": "" }, value), h("div", { class: "small" }, note));
  const copy = h("button", { type: "button", class: "btn small" }, "Copy");
  copy.addEventListener("click", () => navigator.clipboard?.writeText(value).then(() => toast("Copied")));
  box.append(h("div", {}, copy));
  return box;
}

// ---------- tenant list ----------
async function renderTenants() {
  const page = clear($("#page"));
  const { data } = await api.get("/admin/tenants?limit=500");
  const form = h(
    "form",
    { class: "card grid2", id: "create-tenant" },
    h("label", {}, h("span", {}, "Business name"), h("input", { name: "name", required: true, maxlength: 200 })),
    h("label", {}, h("span", {}, "Status"), h("select", { name: "status" }, STATUSES.map((s) => h("option", { value: s, selected: s === "trial" }, s)))),
    h("label", {}, h("span", {}, "Time zone"), h("input", { name: "timezone", value: "Asia/Karachi" })),
    h("div", { class: "row" }, h("button", { class: "btn primary", type: "submit" }, "Create tenant")),
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const r = await act(form.querySelector("button"), () => api.post("/admin/tenants", formData(form)), "Tenant created");
    if (r) location.hash = `#/tenants/${r.tenant.id}`;
  });
  page.append(
    h("h2", {}, "Tenants"),
    form,
    h(
      "div",
      { class: "card table-wrap" },
      h(
        "table",
        {},
        h("thead", {}, h("tr", {}, h("th", {}, "Name"), h("th", {}, "Status"), h("th", { class: "num" }, "Credits"), h("th", { class: "num" }, "Numbers"), h("th", { class: "num" }, "Sent"), h("th", {}, "Created"))),
        h(
          "tbody",
          {},
          data.length
            ? data.map((t) =>
                h(
                  "tr",
                  {},
                  h("td", {}, h("a", { href: `#/tenants/${t.id}` }, t.name), h("div", { class: "mono muted" }, t.id)),
                  h("td", {}, h("span", { class: `badge ${["suspended", "cancelled"].includes(t.status) ? "warn" : t.status === "active" ? "" : "grey"}` }, t.status)),
                  h("td", { class: "num" }, Number(t.balance).toLocaleString("en-US")),
                  h("td", { class: "num" }, t.numbers),
                  h("td", { class: "num" }, t.messages_sent),
                  h("td", {}, formatDateTime(t.created_at)),
                ),
              )
            : h("tr", {}, h("td", { colspan: 6, class: "empty" }, "No tenants yet")),
        ),
      ),
    ),
  );
}

// ---------- tenant detail ----------
async function renderTenant(id) {
  const page = clear($("#page"));
  const [{ tenant }, numbers, keys, hooks] = await Promise.all([
    api.get(`/admin/tenants/${id}`),
    api.get(`/admin/tenants/${id}/numbers`),
    api.get(`/admin/tenants/${id}/api-keys`),
    api.get(`/admin/tenants/${id}/webhook-endpoints`),
  ]);
  const reload = () => renderTenant(id).catch(fail);
  const reveal = h("div", { id: "reveal" });

  // header + status
  const status = h("select", { "aria-label": "Tenant status" }, STATUSES.map((s) => h("option", { value: s, selected: s === tenant.status }, s)));
  status.addEventListener("change", () => act(null, () => api.patch(`/admin/tenants/${id}`, { status: status.value }), `Status set to ${status.value}`));
  page.append(
    h("div", { class: "row" }, h("a", { href: "#/" }, "← Tenants")),
    h("div", { class: "row" }, h("h2", {}, tenant.name), h("span", { class: "mono muted" }, tenant.id), h("span", { class: "spacer" }), h("label", { class: "row" }, h("span", {}, "Status"), status)),
    reveal,
  );

  // credits
  const credit = h(
    "form",
    { class: "grid2" },
    h("label", {}, h("span", {}, "Type"), h("select", { name: "kind" }, h("option", { value: "topup" }, "Top-up (+)"), h("option", { value: "adjustment" }, "Adjustment (±)"))),
    h("label", {}, h("span", {}, "Credits"), h("input", { name: "amount", type: "number", step: "1", required: true })),
    h("label", {}, h("span", {}, "Note (required for adjustments)"), h("input", { name: "note", maxlength: 200 })),
    h("div", { class: "row" }, h("button", { class: "btn primary", type: "submit" }, "Apply")),
  );
  credit.addEventListener("submit", async (e) => {
    e.preventDefault();
    const d = formData(credit);
    const r = await act(credit.querySelector("button"), () => api.post(`/admin/tenants/${id}/balance`, { kind: d.kind, amount: Number(d.amount), note: d.note || undefined }));
    if (r) {
      toast(`${formatCredits(r.entry.amount)} credits · balance ${r.balance}`);
      reload();
    }
  });
  page.append(h("section", { class: "card", "aria-labelledby": "credits-h" }, h("h3", { id: "credits-h" }, `Credits: ${Number(tenant.balance).toLocaleString("en-US")}`), credit));

  // numbers
  const connect = h(
    "form",
    { class: "grid2" },
    h("label", {}, h("span", {}, "WABA id"), h("input", { name: "waba_id", inputmode: "numeric", required: true })),
    h("label", {}, h("span", {}, "Phone number id"), h("input", { name: "phone_number_id", inputmode: "numeric", required: true })),
    h("label", {}, h("span", {}, "Access token (system user)"), h("input", { name: "access_token", type: "password", autocomplete: "off", required: true })),
    h("label", {}, h("span", {}, "Label"), h("input", { name: "label", maxlength: 100 })),
    h("div", { class: "row" }, h("button", { class: "btn primary", type: "submit" }, "Connect number")),
  );
  connect.addEventListener("submit", async (e) => {
    e.preventDefault();
    const d = formData(connect);
    if (!d.label) delete d.label;
    const r = await act(connect.querySelector("button"), () => api.post(`/admin/tenants/${id}/numbers`, d), "Number connected");
    if (r) reload();
  });
  page.append(
    h(
      "section",
      { class: "card", "aria-labelledby": "numbers-h" },
      h("h3", { id: "numbers-h" }, "WhatsApp numbers"),
      h(
        "div",
        { class: "table-wrap" },
        h(
          "table",
          {},
          h("thead", {}, h("tr", {}, ["Number", "Ids", "Status", "Quality", ""].map((x) => h("th", {}, x)))),
          h(
            "tbody",
            {},
            numbers.data.length
              ? numbers.data.map((n) =>
                  h(
                    "tr",
                    {},
                    h("td", {}, n.display_phone, n.label ? h("div", { class: "small muted" }, n.label) : null, n.is_default ? h("span", { class: "badge" }, "default") : null),
                    h("td", { class: "mono" }, `WABA ${n.waba_id}`, h("br"), `Phone ${n.phone_number_id}`, h("br"), n.id),
                    h("td", {}, n.status),
                    h("td", {}, `${n.quality_rating || "—"} / ${n.messaging_tier || "—"}`),
                    h(
                      "td",
                      { class: "row" },
                      n.is_default ? null : h("button", { type: "button", class: "btn small", onclick: (e) => act(e.target, () => api.patch(`/admin/tenants/${id}/numbers/${n.id}`, { is_default: true }), "Default changed").then(reload) }, "Make default"),
                      h("button", { type: "button", class: "btn small", onclick: (e) => act(e.target, () => api.patch(`/admin/tenants/${id}/numbers/${n.id}`, { status: n.status === "connected" ? "disconnected" : "connected" }), "Updated").then(reload) }, n.status === "connected" ? "Disconnect" : "Reconnect"),
                      h("button", { type: "button", class: "btn small", onclick: (e) => act(e.target, () => api.post(`/admin/tenants/${id}/templates/sync`, { waba_connection_id: n.id })).then((r) => r && toast(`Synced ${r.synced} template(s)`)) }, "Sync templates"),
                    ),
                  ),
                )
              : h("tr", {}, h("td", { colspan: 5, class: "empty" }, "No numbers connected")),
          ),
        ),
      ),
      h("details", {}, h("summary", {}, "Connect a number"), connect),
    ),
  );

  // API keys
  const keyForm = h(
    "form",
    { class: "grid2" },
    h("label", {}, h("span", {}, "Key name"), h("input", { name: "name", required: true, maxlength: 100, placeholder: "e.g. CRM server" })),
    h("label", {}, h("span", {}, "Restrict to number"), h("select", { name: "waba_connection_id" }, h("option", { value: "" }, "All numbers"), numbers.data.map((n) => h("option", { value: n.id }, n.display_phone)))),
    h("div", { class: "row" }, h("button", { class: "btn primary", type: "submit" }, "Create API key")),
  );
  keyForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const d = formData(keyForm);
    const r = await act(keyForm.querySelector("button"), () => api.post(`/admin/tenants/${id}/api-keys`, { name: d.name, ...(d.waba_connection_id ? { waba_connection_id: d.waba_connection_id } : {}) }));
    if (r) {
      await renderTenant(id);
      $("#reveal").append(secretBox("New API key", r.api_key.key, "Copy it now. It will not be shown again."));
    }
  });
  page.append(
    h(
      "section",
      { class: "card", "aria-labelledby": "keys-h" },
      h("h3", { id: "keys-h" }, "API keys"),
      h(
        "div",
        { class: "table-wrap" },
        h(
          "table",
          {},
          h("thead", {}, h("tr", {}, ["Name", "Prefix", "Created", "Last used", ""].map((x) => h("th", {}, x)))),
          h(
            "tbody",
            {},
            keys.data.map((k) =>
              h(
                "tr",
                {},
                h("td", {}, k.name),
                h("td", { class: "mono" }, `${k.prefix}…`),
                h("td", {}, formatDateTime(k.created_at)),
                h("td", {}, k.last_used_at ? formatDateTime(k.last_used_at) : "never"),
                h(
                  "td",
                  {},
                  k.revoked_at
                    ? h("span", { class: "badge warn" }, "revoked")
                    : h("button", { type: "button", class: "btn small danger", onclick: (e) => confirm(`Revoke "${k.name}"? Requests using it will fail immediately.`) && act(e.target, () => api.del(`/admin/tenants/${id}/api-keys/${k.id}`), "Key revoked").then(reload) }, "Revoke"),
                ),
              ),
            ),
          ),
        ),
      ),
      keyForm,
    ),
  );

  // webhooks
  const hookForm = h(
    "form",
    { class: "grid2" },
    h("label", {}, h("span", {}, "HTTPS URL"), h("input", { name: "url", type: "url", required: true, placeholder: "https://example.com/whatsapp-events" })),
    h("fieldset", {}, h("legend", { class: "small muted" }, "Events"), h("label", { class: "row" }, h("input", { type: "checkbox", name: "*", checked: true, style: null }), "All"), EVENTS.map((ev) => h("label", { class: "row" }, h("input", { type: "checkbox", name: ev }), ev))),
    h("div", { class: "row" }, h("button", { class: "btn primary", type: "submit" }, "Add endpoint")),
  );
  hookForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const d = formData(hookForm);
    const events = d["*"] ? ["*"] : EVENTS.filter((ev) => d[ev]);
    const r = await act(hookForm.querySelector("button"), () => api.post(`/admin/tenants/${id}/webhook-endpoints`, { url: d.url, events }));
    if (r) {
      await renderTenant(id);
      $("#reveal").append(secretBox("Webhook signing secret", r.webhook_endpoint.secret, "Give this to the tenant to verify the X-WA-Signature header. It will not be shown again."));
    }
  });
  page.append(
    h(
      "section",
      { class: "card", "aria-labelledby": "hooks-h" },
      h("h3", { id: "hooks-h" }, "Webhook endpoints"),
      h(
        "div",
        { class: "table-wrap" },
        h(
          "table",
          {},
          h("thead", {}, h("tr", {}, ["URL", "Events", "Status", ""].map((x) => h("th", {}, x)))),
          h(
            "tbody",
            {},
            hooks.data.map((w) =>
              h(
                "tr",
                {},
                h("td", { class: "mono" }, w.url),
                h("td", { class: "small" }, w.events.join(", ")),
                h("td", {}, w.active ? "active" : "paused"),
                h("td", {}, h("button", { type: "button", class: "btn small", onclick: (e) => act(e.target, () => api.patch(`/admin/tenants/${id}/webhook-endpoints/${w.id}`, { active: !w.active }), "Updated").then(reload) }, w.active ? "Pause" : "Resume")),
              ),
            ),
          ),
        ),
      ),
      hookForm,
    ),
  );
}
