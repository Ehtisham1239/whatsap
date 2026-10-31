import { $, clear, createClient, h, session, toast } from "./dom.js";
import {
  errorMessage, filterConversations, formatCredits, formatDateTime, formatListTime, formatPhone, hasDownloadableMedia,
  messageText, statusLabel, templateFields, toInternational, windowState,
} from "./format.js";

const TOKEN_KEY = "wa.apiKey";
const POLL_MS = 5000;
const state = { status: "open", conversations: [], currentId: null, messages: [], templates: null, numbers: [], view: "inbox", search: "", ledgerCursor: null };
const api = createClient(() => session.get(TOKEN_KEY), () => signOut("Your session ended. Sign in again."));
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));

// ---------- sign in ----------
$("#signin-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const key = $("#api-key").value.trim();
  $("#signin-error").textContent = "";
  session.set(TOKEN_KEY, key);
  try {
    state.numbers = (await api.get("/v1/numbers")).data;
    $("#api-key").value = "";
    start();
  } catch (err) {
    session.set(TOKEN_KEY, null);
    $("#signin-error").textContent = errorMessage(err);
  }
});

function signOut(message) {
  session.set(TOKEN_KEY, null);
  clearInterval(state.timer);
  $("#app").classList.add("hidden");
  $("#signin").classList.remove("hidden");
  if (message) $("#signin-error").textContent = message;
}
$("#signout").addEventListener("click", () => signOut());

async function start() {
  $("#signin").classList.add("hidden");
  $("#app").classList.remove("hidden");
  if (!state.numbers.length) state.numbers = (await api.get("/v1/numbers").catch(() => ({ data: [] }))).data;
  await Promise.all([refreshConversations(), refreshBalance()]);
  clearInterval(state.timer);
  state.timer = setInterval(poll, POLL_MS);
}

async function poll() {
  if (document.hidden || !session.get(TOKEN_KEY)) return;
  try {
    await refreshBalance();
    if (state.view === "inbox") {
      await refreshConversations();
      if (state.currentId) await refreshThread({ keepScroll: true });
    }
  } catch {}
}

if (session.get(TOKEN_KEY)) start().catch(() => signOut());

// ---------- navigation ----------
for (const btn of document.querySelectorAll("nav [data-view]")) {
  btn.addEventListener("click", () => showView(btn.dataset.view));
}
function showView(view) {
  state.view = view;
  for (const b of document.querySelectorAll("nav [data-view]")) {
    if (b.dataset.view === view) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  }
  for (const v of ["inbox", "templates", "wallet", "numbers"]) $(`#view-${v}`).classList.toggle("hidden", v !== view);
  if (view === "templates") renderTemplates();
  if (view === "wallet") renderWallet(true);
  if (view === "numbers") renderNumbers();
  if (view === "inbox") refreshConversations();
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
$("#new-message").addEventListener("click", () => {
  const root = $("#modal-root");
  const phone = h("input", { id: "new-to", placeholder: "+92 300 1234567", required: true, autocomplete: "off" });
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
      if (conv) openConversation(conv.id);
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
});
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

// ---------- numbers ----------
async function renderNumbers() {
  const page = clear($("#view-numbers"));
  state.numbers = (await api.get("/v1/numbers")).data;
  page.append(
    h("h2", {}, "WhatsApp numbers"),
    h(
      "div",
      { class: "card table-wrap" },
      h(
        "table",
        {},
        h("thead", {}, h("tr", {}, ["Number", "Label", "Status", "Quality", "Limit"].map((x) => h("th", {}, x)))),
        h("tbody", {}, state.numbers.map((n) => h("tr", {}, h("td", {}, n.display_phone, n.is_default ? h("span", { class: "badge", style: null }, " default") : null), h("td", {}, n.label || ""), h("td", {}, n.status), h("td", {}, n.quality_rating || "—"), h("td", {}, n.messaging_tier || "—")))),
      ),
    ),
    h("p", { class: "small muted" }, "Numbers are connected by the platform operator."),
  );
}
