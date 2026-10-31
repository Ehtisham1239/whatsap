// All SQL lives here. Every function takes an executor `q` ({ query }) so it
// can run inside or outside a transaction. Every tenant-owned read filters by
// tenant_id: RLS is bypassed by the server's owner connection.
import { ID_PREFIXES, newId } from "../lib/ids.js";

const one = (r) => r.rows[0] ?? null;

// ---- tenants & wallets ----------------------------------------------------

export async function createTenant(q, { name, status = "trial", timezone = "Asia/Karachi", now }) {
  const id = newId(ID_PREFIXES.tenant);
  const tenant = one(await q.query("insert into tenants (id, name, status, timezone, created_at) values ($1,$2,$3,$4,$5) returning *", [id, name, status, timezone, now]));
  await q.query("insert into wallets (tenant_id, balance) values ($1, 0)", [id]);
  return tenant;
}

export async function getTenant(q, id) {
  return one(await q.query("select * from tenants where id = $1", [id]));
}

export async function setTenantStatus(q, id, status) {
  return one(await q.query("update tenants set status = $2 where id = $1 returning *", [id, status]));
}

export async function getBalance(q, tenantId) {
  return one(await q.query("select balance from wallets where tenant_id = $1", [tenantId]))?.balance ?? 0;
}

/** Atomically debits `amount` if the balance allows it; returns the new balance or null. */
export async function debitWallet(q, tenantId, amount) {
  return one(await q.query("update wallets set balance = balance - $2 where tenant_id = $1 and balance >= $2 returning balance", [tenantId, amount]))?.balance ?? null;
}

export async function creditWallet(q, tenantId, amount) {
  const row = one(
    await q.query(
      "insert into wallets (tenant_id, balance) values ($1, $2) on conflict (tenant_id) do update set balance = wallets.balance + excluded.balance returning balance",
      [tenantId, amount],
    ),
  );
  return row.balance;
}

export async function insertLedger(q, { tenantId, kind, amount, balanceAfter, messageId = null, note = null, now }) {
  return one(
    await q.query(
      "insert into credit_ledger (id, tenant_id, kind, amount, balance_after, message_id, note, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8) returning *",
      [newId(ID_PREFIXES.ledger), tenantId, kind, amount, balanceAfter, messageId, note, now],
    ),
  );
}

export async function listLedger(q, tenantId, { limit = 50, before } = {}) {
  const params = [tenantId, limit];
  let cursor = "";
  if (before) {
    params.push(before.created_at, before.id);
    cursor = "and (created_at, id) < ($3, $4)";
  }
  return (await q.query(`select * from credit_ledger where tenant_id = $1 ${cursor} order by created_at desc, id desc limit $2`, params)).rows;
}

// ---- WABA connections -------------------------------------------------------

export async function insertWabaConnection(q, row) {
  return one(
    await q.query(
      `insert into waba_connections (id, tenant_id, waba_id, phone_number_id, display_phone, label, token_cipher, is_default, status, quality_rating, messaging_tier, created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *`,
      [row.id, row.tenant_id, row.waba_id, row.phone_number_id, row.display_phone, row.label ?? null, row.token_cipher, row.is_default ?? false, row.status ?? "connected", row.quality_rating ?? null, row.messaging_tier ?? null, row.created_at],
    ),
  );
}

export async function getWabaConnection(q, tenantId, id) {
  return one(await q.query("select * from waba_connections where tenant_id = $1 and id = $2", [tenantId, id]));
}

export async function getDefaultWabaConnection(q, tenantId) {
  return one(await q.query("select * from waba_connections where tenant_id = $1 and is_default limit 1", [tenantId]));
}

export async function findWabaByPhoneNumberId(q, phoneNumberId) {
  return one(await q.query("select * from waba_connections where phone_number_id = $1", [phoneNumberId]));
}

export async function findWabaByDisplayPhone(q, wabaId, displayPhone) {
  return (await q.query("select * from waba_connections where waba_id = $1 and regexp_replace(display_phone, '[^0-9]', '', 'g') = $2", [wabaId, String(displayPhone).replace(/\D/g, "")])).rows;
}

export async function listWabaConnections(q, tenantId) {
  return (await q.query("select * from waba_connections where tenant_id = $1 order by created_at", [tenantId])).rows;
}

export async function updateWabaConnection(q, id, fields) {
  const allowed = ["label", "token_cipher", "status", "quality_rating", "messaging_tier", "display_phone"];
  const keys = Object.keys(fields).filter((k) => allowed.includes(k));
  if (!keys.length) return one(await q.query("select * from waba_connections where id = $1", [id]));
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
  return one(await q.query(`update waba_connections set ${sets} where id = $1 returning *`, [id, ...keys.map((k) => fields[k])]));
}

export async function setDefaultWabaConnection(q, tenantId, id) {
  await q.query("update waba_connections set is_default = false where tenant_id = $1 and is_default and id <> $2", [tenantId, id]);
  return one(await q.query("update waba_connections set is_default = true where tenant_id = $1 and id = $2 returning *", [tenantId, id]));
}

// ---- API keys ---------------------------------------------------------------

export async function insertApiKey(q, { tenantId, name, prefix, hash, wabaConnectionId = null, now }) {
  return one(
    await q.query(
      "insert into api_keys (id, tenant_id, name, prefix, hash, waba_connection_id, created_at) values ($1,$2,$3,$4,$5,$6,$7) returning id, tenant_id, name, prefix, waba_connection_id, created_at, last_used_at, revoked_at",
      [newId(ID_PREFIXES.apiKey), tenantId, name, prefix, hash, wabaConnectionId, now],
    ),
  );
}

/** Returns the key joined with its tenant, or null when unknown or revoked. */
export async function findActiveApiKeyByHash(q, hash) {
  return one(
    await q.query(
      `select k.id, k.tenant_id, k.name, k.prefix, k.waba_connection_id, k.last_used_at, t.status as tenant_status, t.name as tenant_name
         from api_keys k join tenants t on t.id = k.tenant_id
        where k.hash = $1 and k.revoked_at is null`,
      [hash],
    ),
  );
}

export async function touchApiKey(q, id, now) {
  await q.query("update api_keys set last_used_at = $2 where id = $1", [id, now]);
}

export async function listApiKeys(q, tenantId) {
  return (await q.query("select id, tenant_id, name, prefix, waba_connection_id, created_at, last_used_at, revoked_at from api_keys where tenant_id = $1 order by created_at", [tenantId])).rows;
}

export async function revokeApiKey(q, tenantId, id, now) {
  return one(await q.query("update api_keys set revoked_at = coalesce(revoked_at, $3) where tenant_id = $1 and id = $2 returning id, revoked_at", [tenantId, id, now]));
}

// ---- contacts ---------------------------------------------------------------

/** Inserts the contact if new; fills a missing name. Returns the row. */
export async function upsertContact(q, { tenantId, phone, name = null, source = "api", now }) {
  return one(
    await q.query(
      `insert into contacts (id, tenant_id, phone, name, source, created_at) values ($1,$2,$3,$4,$5,$6)
       on conflict (tenant_id, phone) do update set name = coalesce(contacts.name, excluded.name)
       returning *`,
      [newId(ID_PREFIXES.contact), tenantId, phone, name, source, now],
    ),
  );
}

export async function getContactByPhone(q, tenantId, phone) {
  return one(await q.query("select * from contacts where tenant_id = $1 and phone = $2", [tenantId, phone]));
}

export async function setContactOptOut(q, contactId, at) {
  return one(await q.query("update contacts set opted_out_at = $2 where id = $1 returning *", [contactId, at]));
}

export async function setContactBlocked(q, tenantId, phone, { at, reason }) {
  return one(await q.query("update contacts set blocked_at = $3, block_reason = $4 where tenant_id = $1 and phone = $2 returning *", [tenantId, phone, at, at ? reason ?? null : null]));
}

export async function listContacts(q, tenantId, { limit = 50, after } = {}) {
  const params = [tenantId, limit];
  const cursor = after ? (params.push(after), "and id > $3") : "";
  return (await q.query(`select * from contacts where tenant_id = $1 ${cursor} order by id limit $2`, params)).rows;
}

// ---- windows & conversations ------------------------------------------------

export async function getWindow(q, contactId, wabaConnectionId) {
  return one(await q.query("select * from conversation_windows where contact_id = $1 and waba_connection_id = $2", [contactId, wabaConnectionId]));
}

export async function lockWindow(q, contactId, wabaConnectionId) {
  return one(await q.query("select * from conversation_windows where contact_id = $1 and waba_connection_id = $2 for update", [contactId, wabaConnectionId]));
}

export async function saveWindow(q, { tenantId, contactId, wabaConnectionId, window }) {
  return one(
    await q.query(
      `insert into conversation_windows (tenant_id, contact_id, waba_connection_id, last_inbound_at, expires_at, source) values ($1,$2,$3,$4,$5,$6)
       on conflict (contact_id, waba_connection_id) do update set last_inbound_at = excluded.last_inbound_at, expires_at = excluded.expires_at, source = excluded.source
       returning *`,
      [tenantId, contactId, wabaConnectionId, window.last_inbound_at, window.expires_at, window.source],
    ),
  );
}

/** Returns the open/pending conversation for the pair, creating one if needed. */
export async function getOrCreateConversation(q, { tenantId, contactId, wabaConnectionId, now }) {
  const inserted = one(
    await q.query(
      `insert into conversations (id, tenant_id, contact_id, waba_connection_id, status, last_message_at, created_at)
       values ($1,$2,$3,$4,'open',$5,$5)
       on conflict (contact_id, waba_connection_id) where status <> 'resolved' do nothing
       returning *`,
      [newId(ID_PREFIXES.conversation), tenantId, contactId, wabaConnectionId, now],
    ),
  );
  if (inserted) return inserted;
  return one(await q.query("select * from conversations where contact_id = $1 and waba_connection_id = $2 and status <> 'resolved'", [contactId, wabaConnectionId]));
}

export async function touchConversation(q, id, at, { reopen = false } = {}) {
  await q.query(
    `update conversations set last_message_at = greatest(last_message_at, $2)${reopen ? ", status = case when status = 'pending' then 'open' else status end" : ""} where id = $1`,
    [id, at],
  );
}

export async function listConversations(q, tenantId, { status, limit = 50 } = {}) {
  const params = [tenantId, limit];
  const filter = status ? (params.push(status), "and c.status = $3") : "";
  return (
    await q.query(
      `select c.*, ct.phone, ct.name as contact_name from conversations c join contacts ct on ct.id = c.contact_id
        where c.tenant_id = $1 ${filter} order by c.last_message_at desc limit $2`,
      params,
    )
  ).rows;
}

export async function setConversationStatus(q, tenantId, id, status) {
  return one(await q.query("update conversations set status = $3 where tenant_id = $1 and id = $2 returning *", [tenantId, id, status]));
}

// ---- templates --------------------------------------------------------------

export async function findTemplate(q, { tenantId, wabaId, name, language }) {
  return one(await q.query("select * from templates where tenant_id = $1 and waba_id = $2 and name = $3 and language = $4", [tenantId, wabaId, name, language]));
}

export async function upsertTemplate(q, t) {
  return one(
    await q.query(
      `insert into templates (id, tenant_id, waba_id, name, language, category, status, components, variables, parameter_format, header_format, meta_id, reject_reason, created_at, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14)
       on conflict (tenant_id, waba_id, name, language) do update set
         category = excluded.category, status = excluded.status, components = excluded.components, variables = excluded.variables,
         parameter_format = excluded.parameter_format, header_format = excluded.header_format, meta_id = excluded.meta_id,
         reject_reason = excluded.reject_reason, updated_at = excluded.updated_at
       returning *`,
      [newId(ID_PREFIXES.template), t.tenant_id, t.waba_id, t.name, t.language, t.category, t.status, JSON.stringify(t.components ?? []), t.variables ?? [], t.parameter_format ?? "named", t.header_format ?? "none", t.meta_id ?? null, t.reject_reason ?? null, t.now],
    ),
  );
}

export async function updateTemplateStatusByMetaId(q, { wabaId, metaId, status, reason, now }) {
  return (await q.query("update templates set status = $3, reject_reason = $4, updated_at = $5 where waba_id = $1 and meta_id = $2 returning *", [wabaId, metaId, status, reason, now])).rows;
}

export async function listTemplates(q, tenantId, { status } = {}) {
  const params = [tenantId];
  const filter = status ? (params.push(status), "and status = $2") : "";
  return (await q.query(`select * from templates where tenant_id = $1 ${filter} order by name, language`, params)).rows;
}

// ---- messages ---------------------------------------------------------------

const MESSAGE_COLUMNS = [
  "id", "tenant_id", "conversation_id", "contact_id", "waba_connection_id", "direction", "mode", "type", "content", "template_id",
  "status", "wamid", "error_code", "error_message", "credits_held", "credits_refunded", "conversation_category", "sent_via",
  "api_key_id", "idempotency_key", "scheduled_for", "sent_at", "delivered_at", "read_at", "failed_at", "created_at",
];

export async function insertMessage(q, m) {
  const row = { id: newId(ID_PREFIXES.message), template_id: null, wamid: null, error_code: null, error_message: null, credits_held: 0, credits_refunded: false, conversation_category: null, api_key_id: null, idempotency_key: null, scheduled_for: null, sent_at: null, delivered_at: null, read_at: null, failed_at: null, ...m };
  row.content = JSON.stringify(row.content ?? {});
  const placeholders = MESSAGE_COLUMNS.map((_, i) => `$${i + 1}`).join(",");
  return one(await q.query(`insert into messages (${MESSAGE_COLUMNS.join(",")}) values (${placeholders}) on conflict (wamid) do nothing returning *`, MESSAGE_COLUMNS.map((c) => row[c])));
}

export async function getMessage(q, tenantId, id) {
  return one(await q.query("select * from messages where tenant_id = $1 and id = $2", [tenantId, id]));
}

export async function lockMessage(q, id) {
  return one(await q.query("select * from messages where id = $1 for update", [id]));
}

export async function lockMessageByWamid(q, wamid) {
  return one(await q.query("select * from messages where wamid = $1 for update", [wamid]));
}

export async function updateMessage(q, id, fields) {
  const keys = Object.keys(fields).filter((k) => MESSAGE_COLUMNS.includes(k) && k !== "id" && k !== "tenant_id");
  if (!keys.length) return lockMessage(q, id);
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
  return one(await q.query(`update messages set ${sets} where id = $1 returning *`, [id, ...keys.map((k) => (k === "content" ? JSON.stringify(fields[k]) : fields[k]))]));
}

/** Marks credits refunded exactly once; returns the amount to refund (0 if already done). */
export async function claimRefund(q, id) {
  return one(await q.query("update messages set credits_refunded = true where id = $1 and not credits_refunded and credits_held > 0 returning credits_held", [id]))?.credits_held ?? 0;
}

export async function listMessages(q, tenantId, { limit = 50, before, contactId, conversationId, status } = {}) {
  const params = [tenantId, limit];
  const where = ["tenant_id = $1"];
  if (contactId) where.push(`contact_id = $${params.push(contactId)}`);
  if (conversationId) where.push(`conversation_id = $${params.push(conversationId)}`);
  if (status) where.push(`status = $${params.push(status)}`);
  if (before) where.push(`(created_at, id) < ($${params.push(before.created_at)}, $${params.push(before.id)})`);
  return (await q.query(`select * from messages where ${where.join(" and ")} order by created_at desc, id desc limit $2`, params)).rows;
}

/** Claims due scheduled messages by moving them to queued. Uses SKIP LOCKED so workers don't collide. */
export async function claimDueScheduled(q, now, limit = 50) {
  return (
    await q.query(
      `update messages set status = 'queued' where id in (
         select id from messages where status = 'scheduled' and scheduled_for <= $1 order by scheduled_for limit $2 for update skip locked
       ) returning *`,
      [now, limit],
    )
  ).rows;
}

export async function findStuckQueued(q, olderThan, limit = 100) {
  return (await q.query("select * from messages where status = 'queued' and created_at < $1 and wamid is null order by created_at limit $2", [olderThan, limit])).rows;
}

// ---- idempotency --------------------------------------------------------------

/** Returns { inserted: true } when this request owns the key, else the stored row. */
export async function claimIdempotencyKey(q, { tenantId, key, requestHash, now }) {
  const ins = one(await q.query("insert into idempotency_keys (tenant_id, key, request_hash, created_at) values ($1,$2,$3,$4) on conflict do nothing returning key", [tenantId, key, requestHash, now]));
  if (ins) return { inserted: true };
  return { inserted: false, row: one(await q.query("select * from idempotency_keys where tenant_id = $1 and key = $2", [tenantId, key])) };
}

export async function completeIdempotencyKey(q, { tenantId, key, status, response }) {
  await q.query("update idempotency_keys set response_status = $3, response = $4 where tenant_id = $1 and key = $2", [tenantId, key, status, JSON.stringify(response)]);
}

export async function releaseIdempotencyKey(q, { tenantId, key }) {
  await q.query("delete from idempotency_keys where tenant_id = $1 and key = $2 and response is null", [tenantId, key]);
}

export async function purgeIdempotencyKeys(q, olderThan) {
  return (await q.query("delete from idempotency_keys where created_at < $1", [olderThan])).rowCount ?? 0;
}

// ---- webhook events & endpoints -------------------------------------------------

/** Records a processed Meta webhook event; false when it was already seen. */
export async function recordWebhookEvent(q, { key, payload, now }) {
  const r = await q.query("insert into webhook_events (event_key, payload, received_at) values ($1,$2,$3) on conflict do nothing returning event_key", [key, JSON.stringify(payload), now]);
  return r.rows.length === 1;
}

export async function purgeWebhookEvents(q, olderThan) {
  return (await q.query("delete from webhook_events where received_at < $1", [olderThan])).rowCount ?? 0;
}

export async function insertWebhookEndpoint(q, { tenantId, url, secret, events, now }) {
  return one(
    await q.query("insert into webhook_endpoints (id, tenant_id, url, secret, events, active, created_at) values ($1,$2,$3,$4,$5,true,$6) returning *", [newId(ID_PREFIXES.webhookEndpoint), tenantId, url, secret, events, now]),
  );
}

export async function listActiveWebhookEndpoints(q, tenantId) {
  return (await q.query("select * from webhook_endpoints where tenant_id = $1 and active order by created_at", [tenantId])).rows;
}

export async function listWebhookEndpoints(q, tenantId) {
  return (await q.query("select id, tenant_id, url, events, active, created_at from webhook_endpoints where tenant_id = $1 order by created_at", [tenantId])).rows;
}

export async function setWebhookEndpointActive(q, tenantId, id, active) {
  return one(await q.query("update webhook_endpoints set active = $3 where tenant_id = $1 and id = $2 returning id, tenant_id, url, events, active, created_at", [tenantId, id, active]));
}
