import { $, clear, createClient, h, toast } from "./dom.js";
import {
  errorMessage, filterConversations, formatCredits, formatDateTime, formatListTime, formatPhone, hasDownloadableMedia,
  messageText, recipientsFromCsv, statusLabel, templateFields, toInternational, windowState,
} from "./format.js";

const POLL_MS = 5000;
const ROUTES = {
  dashboard: "Dashboard",
  inbox: "Inbox",
  broadcasts: "Broadcasts",
  contacts: "Contacts",
  templates: "Templates",
  wallet: "Wallet",
  developers: "Developers",
  team: "Team",
  settings: "Settings",
};
const state = { status: "open", conversations: [], currentId: null, messages: [], templates: null, numbers: [], view: null, search: "", ledgerCursor: null, me: null, contactsAfter: null };
const api = createClient(() => null, () => location.replace("/login"));
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
const isManager = () => ["owner", "admin"].includes(state.me?.user?.role);

// ---------- boot ----------
async function boot() {
  try {
    state.me = await api.get("/v1/me");
  } catch {
    location.replace("/login");
    return;
  }
  const { user, tenant } = state.me;
  clear($("#who")).append(h("b", {}, user?.name ?? ""), tenant.name, " · ", user?.role ?? "");
  document.title = `${tenant.name} · AI Platform`;
  state.numbers = (await api.get("/v1/numbers")).data;
  updateBanner();
  await refreshBalance();
  route();
  setInterval(poll, POLL_MS);
}
boot();

function updateBanner() {
  const b = $("#banner");
  const t = state.me.tenant;
  let text = "";
  if (!state.numbers.length) text = "Your WhatsApp number is not connected yet. Our team will link it to your workspace; until then you can explore and set up your team.";
  else if (t.status === "suspended") text = "Sending is paused for this workspace. Contact support.";
  else if (t.status === "pending_activation") text = "Your workspace is waiting for activation.";
  b.textContent = text;
  b.classList.toggle("hidden", !text);
}

$("#signout").addEventListener("click", async (e) => {
  e.preventDefault();
  await api.post("/auth/logout", {}).catch(() => {});
  location.replace("/login");
});
$("#menu").addEventListener("click", () => {
  const open = $("#shell").classList.toggle("nav-open");
  $("#menu").setAttribute("aria-expanded", String(open));
});
$("#shell").addEventListener("click", (e) => {
  if (e.target.closest(".side a")) {
    $("#shell").classList.remove("nav-open");
    $("#menu").setAttribute("aria-expanded", "false");
  }
});

// ---------- routing ----------
window.addEventListener("hashchange", route);
function route() {
  const name = (location.hash.match(/^#\/([a-z]+)/) || [])[1];
  const view = ROUTES[name] ? name : "dashboard";
  state.view = view;
  $("#title").textContent = ROUTES[view];
  for (const a of document.querySelectorAll(".side [data-route]")) {
    if (a.dataset.route === view) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  for (const v of Object.keys(ROUTES)) $(`#view-${v}`).classList.toggle("hidden", v !== view);
  // Numbers can be connected by the operator at any time; keep the banner current.
  api.get("/v1/numbers").then((r) => {
    state.numbers = r.data;
    updateBanner();
  }, () => {});
  const render = { dashboard: renderDashboard, inbox: refreshConversations, broadcasts: renderBroadcasts, contacts: () => renderContacts(true), templates: renderTemplates, wallet: () => renderWallet(true), developers: renderDevelopers, team: renderTeam, settings: renderSettings }[view];
  Promise.resolve(render()).catch((err) => toast(errorMessage(err), "error"));
}

async function poll() {
  if (document.hidden) return;
  try {
    await refreshBalance();
    if (state.view === "inbox") {
      await refreshConversations();
      if (state.currentId) await refreshThread({ keepScroll: true });
    }
  } catch {}
}

async function refreshBalance() {
  const w = await api.get("/v1/wallet?limit=1");
  $("#balance").textContent = `${w.balance.toLocaleString("en-US")} credits`;
}

// ---------- conversations ----------
for (const btn of document.querySelectorAll(".tabs [data-status]")) {
  btn.addEventListener("click", () => {
    state.status = btn.dataset.status;
    for (const b of document.querySelectorAll(".tabs [data-status]")) b.setAttribute("aria-pressed", String(b === btn));
    refreshConversations();
  });
}
$("#search").addEventListener("input", (e) => {
  state.search = e.target.value;
  renderConversations();
});

async function refreshConversations() {
  const qs = state.status ? `?status=${state.status}&limit=200` : "?limit=200";
  state.conversations = (await api.get(`/v1/conversations${qs}`)).data;
  renderConversations();
  const open = state.status === "open" ? state.conversations.length : null;
  if (open !== null) {
    $("#open-count").textContent = String(open);
    $("#open-count").classList.toggle("hidden", !open);
  }
}

function renderConversations() {
  const list = clear($("#conv-list"));
  const items = filterConversations(state.conversations, state.search);
  if (!items.length) {
    list.append(h("div", { class: "empty" }, state.search ? "No matches" : "No conversations yet"));
    return;
  }
  for (const c of items) {
    const w = windowState(c.window_expires_at);
    list.append(
      h(
        "button",
        { type: "button", class: "conv", "aria-current": String(c.id === state.currentId), onclick: () => openConversation(c.id) },
        h("span", { class: "name" }, c.contact_name || formatPhone(c.phone)),
        h("span", { class: "small muted" }, formatListTime(c.last_message_at)),
        h("span", { class: "preview" }, c.blocked ? "🚫 " : "", c.opted_out ? "🔕 " : "", w.open ? "● " : "", c.last_preview || ""),
      ),
    );
  }
}

async function openConversation(id) {
  state.currentId = id;
  $("#view-inbox").classList.add("has-thread");
  renderConversations();
  await refreshThread();
}

function currentConversation() {
  return state.conversations.find((c) => c.id === state.currentId);
}

async function refreshThread({ keepScroll = false } = {}) {
  const id = state.currentId;
  const res = await api.get(`/v1/messages?conversation_id=${encodeURIComponent(id)}&limit=200`);
  if (id !== state.currentId) return;
  const changed = JSON.stringify(res.data) !== JSON.stringify(state.messages);
  state.messages = res.data.slice().reverse();
  if (!keepScroll || changed) renderThread(keepScroll);
}

function renderThread(keepScroll) {
  const thread = clear($("#thread"));
  const c = currentConversation();
  if (!c) {
    thread.append(h("div", { class: "empty" }, "Select a conversation"));
    return;
  }
  const w = windowState(c.window_expires_at);
  thread.append(
    h(
      "div",
      { class: "thread-head" },
      h("button", { type: "button", class: "btn small back", onclick: () => $("#view-inbox").classList.remove("has-thread") }, "← Back"),
      h("div", { class: "who" }, h("b", {}, c.contact_name || formatPhone(c.phone)), h("span", { class: "small muted" }, formatPhone(c.phone))),
      c.opted_out ? h("span", { class: "badge warn" }, "Opted out") : null,
      c.blocked ? h("span", { class: "badge warn" }, "Blocked") : null,
      h("span", { class: "badge grey" }, c.status),
      h("button", { type: "button", class: "btn small", onclick: () => setStatus(c, c.status === "resolved" ? "open" : "resolved") }, c.status === "resolved" ? "Reopen" : "Resolve"),
      c.status === "open" ? h("button", { type: "button", class: "btn small", onclick: () => setStatus(c, "pending") }, "Mark pending") : null,
      h("button", { type: "button", class: "btn small danger", onclick: () => toggleBlock(c) }, c.blocked ? "Unblock" : "Block"),
    ),
  );

  const box = h("div", { class: "messages", id: "messages" });
  let lastDay = "";
  for (const m of state.messages) {
    const day = new Date(m.created_at).toDateString();
    if (day !== lastDay) {
      box.append(h("div", { class: "day" }, new Date(m.created_at).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })));
      lastDay = day;
    }
    const st = statusLabel(m);
    const cls = m.mode === "note" ? "bubble note" : m.direction === "outbound" ? "bubble out" : "bubble";
    box.append(
      h(
        "div",
        { class: cls, dataset: { id: m.id } },
        m.mode === "template" ? h("div", { class: "tpl" }, `Template · ${m.content?.template?.name ?? ""}`) : null,
        h("div", {}, messageText(m)),
        hasDownloadableMedia(m) ? h("button", { type: "button", class: "btn small", onclick: () => downloadMedia(m) }, "Download") : null,
        m.error ? h("div", { class: "err" }, `${m.error.code}: ${m.error.message}`) : null,
        h(
          "div",
          { class: "meta" },
          m.credits ? h("span", {}, `${m.credits} cr${m.credits_refunded ? " refunded" : ""}`) : null,
          h("span", { title: formatDateTime(m.created_at) }, new Date(m.created_at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })),
          st.icon ? h("span", { class: m.status === "failed" ? "failed" : "", title: st.text, "aria-label": st.text }, st.icon) : null,
        ),
      ),
    );
  }
  if (!state.messages.length) box.append(h("div", { class: "empty" }, "No messages yet"));
  thread.append(box);
  thread.append(renderComposer(c, w));
  if (!keepScroll || box.scrollHeight - box.scrollTop - box.clientHeight < 120) box.scrollTop = box.scrollHeight;
}

function renderComposer(c, w) {
  const wrap = h("div", { class: "composer" });
  if (c.blocked || c.opted_out) {
    wrap.append(h("div", { class: "window closed" }, c.blocked ? "This contact is blocked. Unblock to message them." : "This contact opted out. They must send START before you can message them."));
    wrap.append(noteForm(c));
    return wrap;
  }
  wrap.append(h("div", { class: `window ${w.open ? "" : "closed"}` }, w.label));
  if (w.open) {
    const text = h("textarea", { id: "reply-text", rows: 2, placeholder: "Type a reply… (Ctrl+Enter to send)", "aria-label": "Reply", maxlength: 4096 });
    const sendBtn = h("button", { class: "btn primary", type: "submit" }, "Send");
    const form = h(
      "form",
      {
        onsubmit: async (e) => {
          e.preventDefault();
          const body = text.value.trim();
          if (!body) return;
          sendBtn.disabled = true;
          try {
            await sendMessage({ to: c.phone, type: "text", text: { body }, waba_connection_id: c.waba_connection_id });
            text.value = "";
          } finally {
            sendBtn.disabled = false;
          }
        },
      },
      h("div", { class: "send-row" }, text, sendBtn),
    );
    text.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) form.requestSubmit();
    });
    wrap.append(form);
  }
  wrap.append(h("details", {}, h("summary", { class: "small" }, w.open ? "Send a template instead" : "Send a template"), templateForm(c.phone, c.waba_connection_id)));
  wrap.append(noteForm(c));
  return wrap;
}

function noteForm(c) {
  const input = h("input", { placeholder: "Internal note (only your team sees it)", "aria-label": "Internal note", maxlength: 4096 });
  return h(
    "form",
    {
      class: "row",
      onsubmit: async (e) => {
        e.preventDefault();
        if (!input.value.trim()) return;
        try {
          await api.post(`/v1/conversations/${c.id}/notes`, { text: input.value });
          input.value = "";
          await refreshThread();
        } catch (err) {
          toast(errorMessage(err), "error");
        }
      },
    },
    h("div", { class: "grow" }, input),
    h("button", { class: "btn small", type: "submit" }, "Add note"),
  );
}

async function loadTemplates(force = false) {
  if (!state.templates || force) state.templates = (await api.get("/v1/templates")).data;
  return state.templates;
}

/** Template picker with one input per variable; used in the thread and the new-message dialog. */
function templateForm(phone, wabaConnectionId, onSent) {
  const form = h("form", { class: "grid2" });
  const select = h("select", { "aria-label": "Template", required: true }, h("option", { value: "" }, "Loading templates…"));
  const fields = h("div", { class: "grid2" });
  const button = h("button", { class: "btn primary", type: "submit" }, "Send template");
  form.append(h("label", {}, h("span", {}, "Template"), select), fields, h("div", { class: "row" }, button));
  loadTemplates().then((list) => {
    clear(select);
    const approved = list.filter((t) => t.status === "approved");
    select.append(h("option", { value: "" }, approved.length ? "Choose a template" : "No approved templates. Sync them on the Templates tab"));
    for (const t of approved) select.append(h("option", { value: t.id }, `${t.name} (${t.language}, ${t.category})`));
  });
  select.addEventListener("change", () => {
    clear(fields);
    const t = state.templates?.find((x) => x.id === select.value);
    for (const v of templateFields(t)) fields.append(h("label", {}, h("span", {}, `{{${v}}}`), h("input", { name: v, required: true, maxlength: 1024 })));
    if (t && ["image", "video", "document"].includes(t.header_format)) fields.append(h("label", {}, h("span", {}, `Header ${t.header_format} URL (https)`), h("input", { name: "__header", type: "url", required: true })));
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const t = state.templates?.find((x) => x.id === select.value);
    if (!t) return;
    const variables = {};
    let header;
    for (const input of fields.querySelectorAll("input")) {
      if (input.name === "__header") header = { link: input.value };
      else variables[input.name] = input.value;
    }
    let to, from;
    try {
      to = typeof phone === "function" ? phone() : phone;
      from = typeof wabaConnectionId === "function" ? wabaConnectionId() : wabaConnectionId;
    } catch {
      return;
    }
    button.disabled = true;
    try {
      const sent = await sendMessage({ to, type: "template", waba_connection_id: from || undefined, template: { name: t.name, language: t.language, variables, ...(header ? { header_media: header } : {}) } });
      if (sent) {
        form.reset();
        clear(fields);
        onSent?.(sent);
      }
    } finally {
      button.disabled = false;
    }
  });
  return form;
}

async function sendMessage(body) {
  if (!body.waba_connection_id) delete body.waba_connection_id;
  try {
    const { message } = await api.post("/v1/messages", body, { headers: { "idempotency-key": uuid() } });
    if (message.status === "failed") toast(`Not sent: ${message.error?.message ?? "failed"}`, "error");
    else toast(message.credits ? `Sent · ${message.credits} credits` : "Sent");
    await Promise.all([refreshConversations(), refreshBalance()]);
    if (state.currentId) await refreshThread();
    return message;
  } catch (err) {
    toast(errorMessage(err), "error");
    return null;
  }
}

async function setStatus(c, status) {
  try {
    await api.post(`/v1/conversations/${c.id}/status`, { status });
    await refreshConversations();
    if (!state.conversations.some((x) => x.id === c.id)) state.conversations.push({ ...c, status });
    renderThread();
  } catch (err) {
    toast(errorMessage(err), "error");
  }
}

async function toggleBlock(c) {
  if (!c.blocked && !confirm(`Block ${formatPhone(c.phone)}? You will not be able to message them.`)) return;
  try {
    await api.post(`/v1/contacts/${c.phone}/block`, { blocked: !c.blocked });
    c.blocked = !c.blocked;
    await refreshConversations();
    renderThread();
  } catch (err) {
    toast(errorMessage(err), "error");
  }
}

async function downloadMedia(m) {
  try {
    const res = await api.get(`/v1/messages/${m.id}/media`, { raw: true });
    const url = URL.createObjectURL(await res.blob());
    const a = h("a", { href: url, download: m.content?.filename || `${m.type}-${m.id}` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  } catch (err) {
    toast(errorMessage(err), "error");
  }
}

// ---------- new message dialog ----------
$("#new-message").addEventListener("click", () => openNewMessage());
function openNewMessage(prefill = "") {
  const root = $("#modal-root");
  const phone = h("input", { id: "new-to", placeholder: "+92 300 1234567", required: true, autocomplete: "off", value: prefill ? `+${prefill}` : "" });
  const number = h("select", { "aria-label": "From number" }, state.numbers.map((n) => h("option", { value: n.id, selected: n.is_default }, `${n.display_phone}${n.label ? ` · ${n.label}` : ""}`)));
  const err = h("p", { class: "error-text small", role: "alert" });
  const close = () => clear(root);
  const form = templateForm(
    () => {
      const to = toInternational(phone.value);
      err.textContent = to ? "" : "Enter the number with country code, e.g. +92 300 1234567";
      if (!to) throw new Error("invalid number");
      return to;
    },
    () => (state.numbers.length > 1 ? number.value : null),
    async (sent) => {
      close();
      await refreshConversations();
      const conv = state.conversations.find((c) => c.id === sent.conversation_id);
      if (conv) {
        location.hash = "#/inbox";
        openConversation(conv.id);
      }
    },
  );
  root.append(
    h(
      "div",
      { class: "modal", role: "dialog", "aria-modal": "true", "aria-labelledby": "nm-title", onclick: (e) => e.target === e.currentTarget && close() },
      h(
        "div",
        { class: "card" },
        h("h2", { id: "nm-title", style: null }, "New message"),
        h("p", { class: "small muted" }, "A new conversation must start with an approved template. Free-form replies unlock for 24 hours once the contact answers."),
        h("label", {}, h("span", {}, "To"), phone),
        state.numbers.length > 1 ? h("label", {}, h("span", {}, "From"), number) : null,
        err,
        form,
        h("div", { class: "row" }, h("button", { type: "button", class: "btn", onclick: close }, "Cancel")),
      ),
    ),
  );
  phone.focus();
}
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") clear($("#modal-root"));
});

// ---------- templates ----------
async function renderTemplates() {
  const page = clear($("#view-templates"));
  const body = h("tbody");
  const syncBtn = h("button", { class: "btn primary", type: "button" }, "Sync from WhatsApp");
  syncBtn.addEventListener("click", async () => {
    syncBtn.disabled = true;
    try {
      const r = await api.post("/v1/templates/sync", {});
      toast(`Synced ${r.synced} template(s)${r.skipped ? `, skipped ${r.skipped}` : ""}`);
      await loadTemplates(true);
      fill();
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      syncBtn.disabled = false;
    }
  });
  page.append(
    h("div", { class: "row" }, h("h2", { style: null }, "Message templates"), h("span", { class: "spacer" }), syncBtn),
    h("p", { class: "muted small" }, "Create and edit templates in WhatsApp Manager; review results update here automatically."),
    h("div", { class: "card table-wrap" }, h("table", {}, h("thead", {}, h("tr", {}, ["Name", "Language", "Category", "Status", "Variables"].map((x) => h("th", {}, x)))), body)),
  );
  function fill() {
    clear(body);
    if (!state.templates.length) body.append(h("tr", {}, h("td", { colspan: 5, class: "empty" }, "No templates yet. Press Sync.")));
    for (const t of state.templates) {
      body.append(
        h(
          "tr",
          {},
          h("td", {}, h("b", {}, t.name)),
          h("td", {}, t.language),
          h("td", {}, t.category),
          h("td", {}, h("span", { class: `badge ${t.status === "approved" ? "" : t.status === "rejected" || t.status === "disabled" ? "warn" : "grey"}` }, t.status), t.reject_reason ? h("div", { class: "small error-text" }, t.reject_reason) : null),
          h("td", { class: "mono" }, templateFields(t).map((v) => `{{${v}}}`).join(" ")),
        ),
      );
    }
  }
  await loadTemplates(true);
  fill();
}

// ---------- wallet ----------
async function renderWallet(reset) {
  const page = $("#view-wallet");
  if (reset) {
    clear(page);
    state.ledgerCursor = null;
    page.append(
      h("h2", {}, "Wallet"),
      h("div", { class: "card" }, h("div", { class: "muted small" }, "Balance"), h("div", { id: "wallet-balance", style: null, class: "balance" }, "…")),
      h("div", { class: "card table-wrap" }, h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "When"), h("th", {}, "Type"), h("th", { class: "num" }, "Credits"), h("th", { class: "num" }, "Balance"), h("th", {}, "Details"))), h("tbody", { id: "ledger" }))),
      h("div", { class: "row" }, h("button", { class: "btn hidden", id: "ledger-more", type: "button", onclick: () => renderWallet(false) }, "Load more")),
    );
  }
  const w = await api.get(`/v1/wallet?limit=50${state.ledgerCursor ? `&before=${state.ledgerCursor}` : ""}`);
  $("#wallet-balance").textContent = `${w.balance.toLocaleString("en-US")} credits`;
  for (const l of w.ledger) {
    $("#ledger").append(h("tr", {}, h("td", {}, formatDateTime(l.created_at)), h("td", {}, l.kind), h("td", { class: "num" }, formatCredits(l.amount)), h("td", { class: "num" }, l.balance_after.toLocaleString("en-US")), h("td", { class: "small muted" }, l.note || (l.message_id ? `Message ${l.message_id}` : ""))));
  }
  if (reset && !w.ledger.length) $("#ledger").append(h("tr", {}, h("td", { colspan: 5, class: "empty" }, "No transactions yet")));
  state.ledgerCursor = w.next_cursor;
  $("#ledger-more").classList.toggle("hidden", !w.next_cursor);
}

// ---------- shared bits ----------
function card(title, ...children) {
  return h("section", { class: "card" }, title ? h("h3", { style: null }, title) : null, ...children);
}

function table(headers, rows, empty = "Nothing here yet") {
  return h(
    "div",
    { class: "table-wrap" },
    h("table", {}, h("thead", {}, h("tr", {}, headers.map((x) => (typeof x === "string" ? h("th", {}, x) : x)))), h("tbody", {}, rows.length ? rows : h("tr", {}, h("td", { colspan: headers.length, class: "empty" }, empty)))),
  );
}

function secretBox(title, value, note) {
  const copy = h("button", { type: "button", class: "btn small" }, "Copy");
  copy.addEventListener("click", () => navigator.clipboard?.writeText(value).then(() => toast("Copied")));
  return h("div", { class: "secret-box", role: "alert" }, h("b", {}, title), h("div", { class: "mono", "data-secret": "" }, value), h("div", { class: "small" }, note), h("div", {}, copy));
}

function formValues(form) {
  return Object.fromEntries([...new FormData(form)].map(([k, v]) => [k, typeof v === "string" ? v.trim() : v]));
}

async function submitting(form, fn) {
  const btn = form.querySelector('button[type="submit"]');
  if (btn) btn.disabled = true;
  try {
    return await fn();
  } catch (err) {
    toast(errorMessage(err), "error");
    return null;
  } finally {
    if (btn) btn.disabled = false;
  }
}

const managerOnly = () => h("p", { class: "muted" }, "Only workspace owners and admins can manage this.");

// ---------- dashboard ----------
async function renderDashboard() {
  const page = clear($("#view-dashboard"));
  const s = await api.get("/v1/stats?days=7");
  const t = s.totals;
  const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : "—");
  const stat = (v, l) => h("div", { class: "stat" }, h("span", { class: "v" }, v), h("span", { class: "l" }, l));

  // seven bars, filling days without traffic
  const byDay = new Map(s.daily.map((d) => [d.day, d]));
  const days = [];
  for (let i = s.days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400_000);
    const key = d.toLocaleDateString("en-CA");
    days.push({ key, label: d.toLocaleDateString("en-GB", { weekday: "short" }), sent: byDay.get(key)?.sent ?? 0 });
  }
  const max = Math.max(1, ...days.map((d) => d.sent));
  const templates = await loadTemplates().catch(() => []);
  const steps = [
    ["Create your workspace", true],
    ["Connect a WhatsApp number", state.numbers.length > 0],
    ["Sync approved templates", templates.some((x) => x.status === "approved")],
    ["Add credits", s.balance > 0],
    ["Send your first message", t.sent > 0],
  ];
  const done = steps.filter(([, d]) => d).length;

  page.append(
    h("div", { class: "row" }, h("h2", {}, `Welcome, ${state.me.user?.name?.split(" ")[0] ?? ""}`), h("span", { class: "spacer" }), h("span", { class: "muted small" }, "Last 7 days")),
    h(
      "div",
      { class: "stats" },
      stat(t.sent.toLocaleString("en-US"), "Messages sent"),
      stat(pct(t.delivered, t.sent), "Delivered"),
      stat(pct(t.read, t.sent), "Read"),
      stat(t.failed.toLocaleString("en-US"), "Failed (refunded)"),
      stat(t.received.toLocaleString("en-US"), "Messages received"),
      stat(String(s.conversations.open), "Open conversations"),
      stat(String(s.open_windows), "Reply windows open"),
      stat(s.balance.toLocaleString("en-US"), "Credits left"),
    ),
    h(
      "div",
      { class: "grid2" },
      card(
        "Messages sent per day",
        h(
          "div",
          { class: "bars", role: "img", "aria-label": days.map((d) => `${d.label} ${d.sent}`).join(", ") },
          days.map((d) => h("div", { class: "bar" }, h("div", { class: "fill", dataset: { h: String(Math.round((d.sent / max) * 100)) }, title: `${d.sent} sent` }), h("span", {}, d.label))),
        ),
      ),
      done < steps.length
        ? card(`Get started · ${done}/${steps.length}`, h("ul", { class: "checklist" }, steps.map(([label, ok]) => h("li", { class: ok ? "done" : "" }, h("span", { class: "tick", "aria-hidden": "true" }, ok ? "✓" : ""), h("span", {}, label, ok ? h("span", { class: "sr-only" }, " (done)") : null)))))
        : card("Contacts", h("p", {}, `${s.contacts.total.toLocaleString("en-US")} contacts · ${s.contacts.opted_out} opted out`), h("a", { href: "#/contacts" }, "View contacts →")),
    ),
  );
  // Heights are applied through CSSOM (style attributes would be blocked by the CSP).
  for (const f of page.querySelectorAll(".fill")) f.style.height = `${f.dataset.h}%`;
}

// ---------- contacts ----------
async function renderContacts(reset) {
  const page = $("#view-contacts");
  if (reset) {
    clear(page);
    state.contactsAfter = null;
    page.append(
      h("div", { class: "row" }, h("h2", {}, "Contacts"), h("span", { class: "spacer" }), h("span", { class: "small muted" }, "Contacts are added automatically when they message you or you message them.")),
      h("div", { class: "card table-wrap" }, h("table", {}, h("thead", {}, h("tr", {}, ["Name", "Number", "Source", "Status", "Added", ""].map((x) => h("th", {}, x)))), h("tbody", { id: "contacts-body" }))),
      h("div", { class: "row" }, h("button", { type: "button", class: "btn hidden", id: "contacts-more", onclick: () => renderContacts(false) }, "Load more")),
    );
  }
  const r = await api.get(`/v1/contacts?limit=100${state.contactsAfter ? `&after=${state.contactsAfter}` : ""}`);
  const body = $("#contacts-body");
  for (const c of r.data) {
    body.append(
      h(
        "tr",
        {},
        h("td", {}, c.name || "—"),
        h("td", {}, formatPhone(c.phone)),
        h("td", {}, c.source),
        h("td", {}, c.blocked ? h("span", { class: "badge warn" }, "blocked") : c.opted_out ? h("span", { class: "badge warn" }, "opted out") : h("span", { class: "badge" }, "active")),
        h("td", {}, formatDateTime(c.created_at)),
        h(
          "td",
          { class: "row" },
          c.blocked || c.opted_out ? null : h("button", { type: "button", class: "btn small", onclick: () => openNewMessage(c.phone) }, "Message"),
          h(
            "button",
            {
              type: "button",
              class: "btn small",
              onclick: async () => {
                try {
                  await api.post(`/v1/contacts/${c.phone}/block`, { blocked: !c.blocked });
                  renderContacts(true);
                } catch (err) {
                  toast(errorMessage(err), "error");
                }
              },
            },
            c.blocked ? "Unblock" : "Block",
          ),
        ),
      ),
    );
  }
  if (reset && !r.data.length) body.append(h("tr", {}, h("td", { colspan: 6, class: "empty" }, "No contacts yet")));
  state.contactsAfter = r.next_after;
  $("#contacts-more").classList.toggle("hidden", !r.next_after);
}

// ---------- developers ----------
async function renderDevelopers() {
  const page = clear($("#view-developers"));
  const reveal = h("div");
  page.append(h("h2", {}, "Developers"), reveal);
  if (!isManager()) {
    page.append(card("API access", managerOnly()));
    return;
  }
  const [keys, hooks] = await Promise.all([api.get("/v1/api-keys"), api.get("/v1/webhook-endpoints")]);
  const keyForm = h(
    "form",
    { class: "grid2" },
    h("label", {}, h("span", {}, "Key name"), h("input", { name: "name", required: true, maxlength: 100, placeholder: "e.g. Website backend" })),
    h("label", {}, h("span", {}, "Restrict to number"), h("select", { name: "waba_connection_id" }, h("option", { value: "" }, "All numbers"), state.numbers.map((n) => h("option", { value: n.id }, n.display_phone)))),
    h("div", { class: "row" }, h("button", { class: "btn primary", type: "submit" }, "Create API key")),
  );
  keyForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const v = formValues(keyForm);
    const r = await submitting(keyForm, () => api.post("/v1/api-keys", { name: v.name, ...(v.waba_connection_id ? { waba_connection_id: v.waba_connection_id } : {}) }));
    if (r) {
      await renderDevelopers();
      $("#view-developers .secret-slot")?.append(secretBox("Your new API key", r.api_key.key, "Copy it now and store it securely. It will not be shown again."));
    }
  });
  const hookForm = h(
    "form",
    { class: "grid2" },
    h("label", {}, h("span", {}, "Endpoint URL (https)"), h("input", { name: "url", type: "url", required: true, placeholder: "https://example.com/whatsapp-events" })),
    h("div", { class: "row" }, h("button", { class: "btn primary", type: "submit" }, "Add webhook")),
  );
  hookForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const r = await submitting(hookForm, () => api.post("/v1/webhook-endpoints", { url: formValues(hookForm).url }));
    if (r) {
      await renderDevelopers();
      $("#view-developers .secret-slot")?.append(secretBox("Webhook signing secret", r.webhook_endpoint.secret, "Use it to verify the X-WA-Signature header. It will not be shown again."));
    }
  });
  reveal.className = "secret-slot";
  page.append(
    card(
      "API keys",
      table(
        ["Name", "Key", "Created", "Last used", ""],
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
                : h(
                    "button",
                    {
                      type: "button",
                      class: "btn small danger",
                      onclick: async () => {
                        if (!confirm(`Revoke "${k.name}"? Apps using it will stop working immediately.`)) return;
                        await api.del(`/v1/api-keys/${k.id}`).catch((err) => toast(errorMessage(err), "error"));
                        renderDevelopers();
                      },
                    },
                    "Revoke",
                  ),
            ),
          ),
        ),
        "No API keys yet",
      ),
      keyForm,
    ),
    card(
      "Webhooks",
      h("p", { class: "small muted" }, "We POST message.received, message.status, contact.opted_out, contact.opted_in and template.status events to your endpoint."),
      table(
        ["URL", "Events", "Status", ""],
        hooks.data.map((w) =>
          h(
            "tr",
            {},
            h("td", { class: "mono" }, w.url),
            h("td", { class: "small" }, w.events.join(", ")),
            h("td", {}, w.active ? "active" : "paused"),
            h(
              "td",
              {},
              h(
                "button",
                {
                  type: "button",
                  class: "btn small",
                  onclick: async () => {
                    await api.patch(`/v1/webhook-endpoints/${w.id}`, { active: !w.active }).catch((err) => toast(errorMessage(err), "error"));
                    renderDevelopers();
                  },
                },
                w.active ? "Pause" : "Resume",
              ),
            ),
          ),
        ),
        "No webhooks yet",
      ),
      hookForm,
    ),
    card(
      "Send a message from your code",
      h(
        "pre",
        { class: "code" },
        `curl -X POST ${location.origin}/v1/messages \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Idempotency-Key: order-1042" \\
  -H "Content-Type: application/json" \\
  -d '{"to":"+923001234567","type":"template",
       "template":{"name":"order_update","language":"en",
                   "variables":{"1":"Ali","2":"#1042"}}}'`,
      ),
    ),
  );
}

// ---------- team ----------
async function renderTeam() {
  const page = clear($("#view-team"));
  const { data } = await api.get("/v1/users");
  const me = state.me.user;
  const rows = data.map((u) => {
    const actions = [];
    if (isManager() && u.id !== me.id) {
      const role = h("select", { "aria-label": `Role for ${u.name}` }, ["agent", "admin", "owner"].map((r) => h("option", { value: r, selected: r === u.role }, r)));
      role.addEventListener("change", async () => {
        try {
          await api.patch(`/v1/users/${u.id}`, { role: role.value });
          toast("Role updated");
        } catch (err) {
          toast(errorMessage(err), "error");
          role.value = u.role;
        }
      });
      actions.push(role);
      actions.push(
        h(
          "button",
          {
            type: "button",
            class: `btn small ${u.disabled_at ? "" : "danger"}`,
            onclick: async () => {
              if (!u.disabled_at && !confirm(`Remove access for ${u.name}? They are signed out immediately.`)) return;
              await api.patch(`/v1/users/${u.id}`, { disabled: !u.disabled_at }).catch((err) => toast(errorMessage(err), "error"));
              renderTeam();
            },
          },
          u.disabled_at ? "Restore access" : "Remove access",
        ),
      );
    }
    return h(
      "tr",
      {},
      h("td", {}, h("b", {}, u.name), u.id === me.id ? h("span", { class: "small muted" }, " (you)") : null),
      h("td", {}, u.email),
      h("td", {}, actions.length ? null : u.role, u.disabled_at ? h("span", { class: "badge warn" }, "no access") : null),
      h("td", {}, u.last_login_at ? formatDateTime(u.last_login_at) : "never"),
      h("td", { class: "row" }, actions),
    );
  });
  page.append(h("h2", {}, "Team"), card("Members", table(["Name", "Email", "Role", "Last sign-in", ""], rows)));
  if (!isManager()) {
    page.append(card("Add a teammate", managerOnly()));
    return;
  }
  const form = h(
    "form",
    { class: "grid2" },
    h("label", {}, h("span", {}, "Name"), h("input", { name: "name", required: true, maxlength: 100 })),
    h("label", {}, h("span", {}, "Email"), h("input", { name: "email", type: "email", required: true })),
    h("label", {}, h("span", {}, "Role"), h("select", { name: "role" }, h("option", { value: "agent" }, "Agent: inbox and contacts"), h("option", { value: "admin" }, "Admin: also keys, webhooks and team"), me.role === "owner" ? h("option", { value: "owner" }, "Owner: full access") : null)),
    h("label", {}, h("span", {}, "Temporary password (min 10 characters)"), h("input", { name: "password", type: "text", required: true, minlength: 10, autocomplete: "off" })),
    h("div", { class: "row" }, h("button", { class: "btn primary", type: "submit" }, "Add teammate")),
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const r = await submitting(form, () => api.post("/v1/users", formValues(form)));
    if (r) {
      toast(`${r.user.name} added. Share the password privately; they can change it in Settings.`);
      renderTeam();
    }
  });
  page.append(card("Add a teammate", h("p", { class: "small muted" }, "Teammates sign in at this site with their email and the password you set."), form));
}

// ---------- settings ----------
async function renderSettings() {
  const page = clear($("#view-settings"));
  const { user, tenant } = state.me;
  state.numbers = (await api.get("/v1/numbers")).data;
  const pw = h(
    "form",
    { class: "grid2" },
    h("label", {}, h("span", {}, "Current password"), h("input", { name: "current_password", type: "password", required: true, autocomplete: "current-password" })),
    h("label", {}, h("span", {}, "New password"), h("input", { name: "new_password", type: "password", required: true, minlength: 10, autocomplete: "new-password" })),
    h("div", { class: "row" }, h("button", { class: "btn primary", type: "submit" }, "Change password")),
  );
  pw.addEventListener("submit", async (e) => {
    e.preventDefault();
    const r = await submitting(pw, () => api.post("/v1/me/password", formValues(pw)));
    if (r) {
      pw.reset();
      toast("Password changed. Other devices were signed out.");
    }
  });
  page.append(
    h("h2", {}, "Settings"),
    card("Workspace", h("p", {}, h("b", {}, tenant.name), " · ", h("span", { class: "badge grey" }, tenant.status)), h("p", { class: "mono muted" }, tenant.id)),
    card("Your profile", h("p", {}, h("b", {}, user.name), h("br"), user.email, h("br"), h("span", { class: "small muted" }, `Role: ${user.role}`))),
    card("Change password", pw),
    card(
      "WhatsApp numbers",
      table(
        ["Number", "Label", "Status", "Quality", "Limit"],
        state.numbers.map((n) => h("tr", {}, h("td", {}, n.display_phone, n.is_default ? h("span", { class: "badge" }, " default") : null), h("td", {}, n.label || ""), h("td", {}, n.status), h("td", {}, n.quality_rating || "—"), h("td", {}, n.messaging_tier || "—"))),
        "No number connected yet. Our team connects your WhatsApp Business number for you.",
      ),
    ),
  );
}

// ---------- broadcasts ----------
async function renderBroadcasts() {
  const page = clear($("#view-broadcasts"));
  const [{ data }, templates] = await Promise.all([api.get("/v1/broadcasts"), loadTemplates(true)]);
  const approved = templates.filter((x) => x.status === "approved");
  const pctOf = (n, total) => (total ? `${Math.round((n / total) * 100)}%` : "0%");
  const stateBadge = { scheduled: "grey", sending: "", completed: "", cancelled: "warn" };

  page.append(
    h("div", { class: "row" }, h("h2", {}, "Broadcasts"), h("span", { class: "spacer" }), h("span", { class: "small muted" }, "Send an approved template to many contacts at once.")),
    card(
      "Recent broadcasts",
      table(
        ["Name", "Template", "Status", "Recipients", "Delivered", "Read", "Failed", "Credits", ""],
        data.map((b) => {
          const delivered = b.counts.delivered + b.counts.read;
          return h(
            "tr",
            {},
            h("td", {}, h("b", {}, b.name), h("div", { class: "small muted" }, b.state === "scheduled" ? `Sends ${formatDateTime(b.scheduled_for)}` : formatDateTime(b.created_at))),
            h("td", {}, `${b.template.name} (${b.template.language})`),
            h("td", {}, h("span", { class: `badge ${stateBadge[b.state] ?? "grey"}` }, b.state)),
            h("td", { class: "num" }, String(b.total), b.skipped ? h("div", { class: "small muted" }, `${b.skipped} skipped`) : null),
            h("td", { class: "num" }, pctOf(delivered, b.total)),
            h("td", { class: "num" }, pctOf(b.counts.read, b.total)),
            h("td", { class: "num" }, String(b.counts.failed)),
            h("td", { class: "num" }, String(b.credits)),
            h(
              "td",
              {},
              ["scheduled", "sending"].includes(b.state)
                ? h(
                    "button",
                    {
                      type: "button",
                      class: "btn small danger",
                      onclick: async () => {
                        if (!confirm(`Cancel "${b.name}"? Messages not yet sent are cancelled and refunded.`)) return;
                        try {
                          await api.post(`/v1/broadcasts/${b.id}/cancel`, {});
                          toast("Broadcast cancelled");
                          renderBroadcasts();
                          refreshBalance();
                        } catch (err) {
                          toast(errorMessage(err), "error");
                        }
                      },
                    },
                    "Cancel",
                  )
                : null,
            ),
          );
        }),
        "No broadcasts yet",
      ),
    ),
  );

  // new broadcast
  const name = h("input", { name: "name", required: true, maxlength: 120, placeholder: "e.g. Eid offer" });
  const select = h("select", { name: "template", required: true }, h("option", { value: "" }, approved.length ? "Choose a template" : "No approved templates. Sync them on the Templates page"), approved.map((x) => h("option", { value: x.id }, `${x.name} (${x.language}, ${x.category})`)));
  const csv = h("textarea", { name: "csv", rows: 7, class: "mono", placeholder: "phone,1\n+923001234567,Ali", "aria-describedby": "csv-help" });
  const file = h("input", { type: "file", accept: ".csv,text/csv,text/plain", "aria-label": "Upload CSV file" });
  const when = h("input", { type: "datetime-local", name: "when", "aria-label": "Send later (optional)" });
  const preview = h("div", { class: "small", role: "status" });
  const submit = h("button", { class: "btn primary", type: "submit" }, "Send broadcast");
  const current = () => approved.find((x) => x.id === select.value);
  function refreshPreview() {
    const t = current();
    clear(preview);
    if (!t) return;
    const parsed = recipientsFromCsv(csv.value, templateFields(t));
    preview.append(h("b", {}, `${parsed.recipients.length} recipient(s)`));
    if (parsed.errors.length) preview.append(h("ul", { class: "error-text" }, parsed.errors.slice(0, 8).map((e) => h("li", {}, e)), parsed.errors.length > 8 ? h("li", {}, `…and ${parsed.errors.length - 8} more`) : null));
    submit.disabled = !parsed.recipients.length || parsed.errors.length > 0;
  }
  select.addEventListener("change", () => {
    const t = current();
    if (t && !csv.value.trim()) csv.value = ["phone", ...templateFields(t)].join(",") + "\n";
    refreshPreview();
  });
  csv.addEventListener("input", refreshPreview);
  file.addEventListener("change", async () => {
    const f = file.files?.[0];
    if (!f) return;
    if (f.size > 900_000) return toast("That file is too large (max about 5,000 rows)", "error");
    csv.value = await f.text();
    refreshPreview();
  });
  const form = h(
    "form",
    { class: "grid2" },
    h("label", {}, h("span", {}, "Broadcast name"), name),
    h("label", {}, h("span", {}, "Template"), select),
    h("label", { class: "wide" }, h("span", {}, "Recipients (CSV with a header row)"), csv, h("span", { id: "csv-help", class: "hint" }, "First column: phone with country code. Then one column per template variable, named like {{1}} or {{first_name}}. Opted-out and blocked contacts are skipped automatically.")),
    h("label", {}, h("span", {}, "…or upload a CSV file"), file),
    h("label", {}, h("span", {}, "Send later (optional, your local time)"), when),
    h("div", { class: "wide" }, preview),
    h("div", { class: "row" }, submit),
  );
  submit.disabled = true;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const t = current();
    if (!t) return;
    const parsed = recipientsFromCsv(csv.value, templateFields(t));
    const body = { name: name.value.trim(), template: { name: t.name, language: t.language }, recipients: parsed.recipients };
    if (when.value) body.schedule_at = new Date(when.value).toISOString();
    const r = await submitting(form, () => api.post("/v1/broadcasts", body));
    if (r) {
      const b = r.broadcast;
      toast(`${b.total} message(s) ${b.state === "scheduled" ? "scheduled" : "sending"} · ${b.credits} credits${b.skipped ? ` · ${b.skipped} skipped` : ""}`);
      renderBroadcasts();
      refreshBalance();
    }
  });
  page.append(card("New broadcast", form));
}
