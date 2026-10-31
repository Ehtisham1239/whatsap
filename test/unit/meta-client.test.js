import { test } from "node:test";
import assert from "node:assert/strict";
import { buildOutboundPayload, createMetaClient, MetaApiError } from "../../src/meta/client.js";

function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    const r = responses.shift();
    if (r instanceof Error) throw r;
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => (r.json === undefined ? JSON.parse("x") : r.json) };
  };
  fn.calls = calls;
  return fn;
}

test("sendMessage posts to the phone number and returns the wamid", async () => {
  const fetch = fakeFetch([{ status: 200, json: { messages: [{ id: "wamid.1" }] } }]);
  const client = createMetaClient({ fetch, graphVersion: "v23.0" });
  const wamid = await client.sendMessage({ phoneNumberId: "2002", token: "tok", payload: { to: "923001234567", type: "text", text: { body: "Hi" } } });
  assert.equal(wamid, "wamid.1");
  assert.equal(fetch.calls[0].url, "https://graph.facebook.com/v23.0/2002/messages");
  assert.equal(fetch.calls[0].init.headers.authorization, "Bearer tok");
  assert.deepEqual(fetch.calls[0].body, { messaging_product: "whatsapp", recipient_type: "individual", to: "923001234567", type: "text", text: { body: "Hi" } });
});

test("API errors map to MetaApiError with retryability", async () => {
  const client = createMetaClient({
    fetch: fakeFetch([
      { status: 400, json: { error: { code: 131026, message: "Undeliverable" } } },
      { status: 429, json: { error: { code: 130429, message: "Rate limit" } } },
      { status: 502 },
    ]),
  });
  const send = () => client.sendMessage({ phoneNumberId: "1", token: "t", payload: {} });
  await assert.rejects(send, (e) => e instanceof MetaApiError && e.code === "131026" && !e.retryable && !e.ambiguous);
  await assert.rejects(send, (e) => e.code === "130429" && e.retryable);
  await assert.rejects(send, (e) => e.status === 502 && e.retryable && e.ambiguous);
});

test("network failures are retryable and ambiguous", async () => {
  const client = createMetaClient({ fetch: fakeFetch([Object.assign(new Error("t"), { name: "TimeoutError" })]) });
  await assert.rejects(client.sendMessage({ phoneNumberId: "1", token: "t", payload: {} }), (e) => e.code === "network_error" && e.retryable && e.ambiguous && /timeout/.test(e.message));
});

test("a success without a message id is treated as ambiguous", async () => {
  const client = createMetaClient({ fetch: fakeFetch([{ status: 200, json: {} }]) });
  await assert.rejects(client.sendMessage({ phoneNumberId: "1", token: "t", payload: {} }), (e) => e.code === "no_message_id" && e.ambiguous);
});

test("non-numeric ids are rejected before any request", async () => {
  const fetch = fakeFetch([]);
  const client = createMetaClient({ fetch });
  await assert.rejects(client.sendMessage({ phoneNumberId: "../me", token: "t", payload: {} }), TypeError);
  await assert.rejects(client.listTemplates({ wabaId: "x", token: "t" }), TypeError);
  assert.equal(fetch.calls.length, 0);
});

test("listTemplates follows paging cursors", async () => {
  const fetch = fakeFetch([
    { status: 200, json: { data: [{ id: "1" }], paging: { cursors: { after: "c1" }, next: "https://next" } } },
    { status: 200, json: { data: [{ id: "2" }], paging: { cursors: { after: "c2" } } } },
  ]);
  const list = await createMetaClient({ fetch }).listTemplates({ wabaId: "1001", token: "t" });
  assert.deepEqual(list.map((t) => t.id), ["1", "2"]);
  assert.match(fetch.calls[1].url, /after=c1$/);
});

test("buildOutboundPayload for each type", () => {
  assert.deepEqual(buildOutboundPayload({ to: "1", type: "text", text: { body: "x", preview_url: true } }), { to: "1", type: "text", text: { body: "x", preview_url: true } });
  assert.deepEqual(buildOutboundPayload({ to: "1", type: "image", media: { link: "https://a" } }), { to: "1", type: "image", image: { link: "https://a" } });
  assert.deepEqual(buildOutboundPayload({ to: "1", type: "template" }, { templatePayload: { name: "t" }, replyTo: "w" }), { to: "1", context: { message_id: "w" }, type: "template", template: { name: "t" } });
  assert.throws(() => buildOutboundPayload({ to: "1", type: "template" }), TypeError);
  assert.throws(() => buildOutboundPayload({ to: "1", type: "poll" }), TypeError);
});

test("isMetaMediaUrl only allows Meta https hosts", async () => {
  const { isMetaMediaUrl } = await import("../../src/meta/client.js");
  assert.ok(isMetaMediaUrl("https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1"));
  assert.ok(isMetaMediaUrl("https://scontent.xx.fbcdn.net/a.jpg"));
  for (const u of ["http://lookaside.fbsbx.com/x", "https://fbsbx.com.evil.example/x", "https://evil.example/fbcdn.net", "not a url", undefined]) assert.ok(!isMetaMediaUrl(u), String(u));
});

test("downloadMedia never sends the token to a non-Meta host and enforces size", async () => {
  const fetch = fakeFetch([]);
  const client = createMetaClient({ fetch });
  await assert.rejects(client.downloadMedia({ url: "https://evil.example/x", token: "t" }), (e) => e.code === "invalid_media_url");
  assert.equal(fetch.calls.length, 0);
  const ok = async () => ({ ok: true, status: 200, headers: new Headers({ "content-type": "image/png" }), arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer });
  const c2 = createMetaClient({ fetch: ok });
  const file = await c2.downloadMedia({ url: "https://lookaside.fbsbx.com/x", token: "t" });
  assert.deepEqual([...file.body], [1, 2, 3]);
  assert.equal(file.contentType, "image/png");
  await assert.rejects(c2.downloadMedia({ url: "https://lookaside.fbsbx.com/x", token: "t", maxBytes: 2 }), (e) => e.code === "media_too_large");
  const notFound = createMetaClient({ fetch: async () => ({ ok: false, status: 404 }) });
  await assert.rejects(notFound.downloadMedia({ url: "https://lookaside.fbsbx.com/x", token: "t" }), (e) => e.status === 404 && !e.retryable);
});

test("getMediaInfo validates the id", async () => {
  const fetch = fakeFetch([{ status: 200, json: { url: "https://lookaside.fbsbx.com/x", mime_type: "image/jpeg" } }]);
  const client = createMetaClient({ fetch });
  await assert.rejects(client.getMediaInfo({ mediaId: "../x", token: "t" }), TypeError);
  assert.equal((await client.getMediaInfo({ mediaId: "123", token: "t" })).mime_type, "image/jpeg");
  assert.match(fetch.calls[0].url, /\/123$/);
});
