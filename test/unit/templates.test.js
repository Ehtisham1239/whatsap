import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTemplatePayload, extractVariables, isValidTemplateName, mapMetaTemplateStatus, renderTemplateText, TemplateError } from "../../src/lib/templates.js";

const named = {
  name: "order_update",
  language: "en_US",
  status: "approved",
  parameter_format: "named",
  header_format: "text",
  components: [
    { type: "HEADER", format: "TEXT", text: "Order {{order_id}}" },
    { type: "BODY", text: "Hi {{first_name}}, order {{order_id}} ships {{ ship_date }}." },
    { type: "FOOTER", text: "Thanks" },
  ],
};
const positional = {
  name: "otp",
  language: "en",
  status: "approved",
  parameter_format: "positional",
  header_format: "none",
  components: [{ type: "BODY", text: "Code {{1}} expires in {{2}} minutes. {{1}}" }],
};

test("isValidTemplateName", () => {
  assert.ok(isValidTemplateName("order_update_2"));
  for (const n of ["", "Order", "has-dash", "a".repeat(513), null]) assert.ok(!isValidTemplateName(n));
});

test("extractVariables returns unique variables in order", () => {
  assert.deepEqual(extractVariables(named.components, "named"), { header: ["order_id"], body: ["first_name", "order_id", "ship_date"] });
  assert.deepEqual(extractVariables(positional.components, "positional"), { header: [], body: ["1", "2"] });
  assert.deepEqual(extractVariables([], "named"), { header: [], body: [] });
});

test("buildTemplatePayload builds named parameters", () => {
  const p = buildTemplatePayload(named, { variables: { first_name: "Ali", order_id: "A-1", ship_date: "Monday" } });
  assert.deepEqual(p, {
    name: "order_update",
    language: { code: "en_US" },
    components: [
      { type: "header", parameters: [{ type: "text", parameter_name: "order_id", text: "A-1" }] },
      {
        type: "body",
        parameters: [
          { type: "text", parameter_name: "first_name", text: "Ali" },
          { type: "text", parameter_name: "order_id", text: "A-1" },
          { type: "text", parameter_name: "ship_date", text: "Monday" },
        ],
      },
    ],
  });
});

test("buildTemplatePayload builds positional parameters and accepts numbers", () => {
  const p = buildTemplatePayload(positional, { variables: { 1: 123456, 2: "10" } });
  assert.deepEqual(p.components, [{ type: "body", parameters: [{ type: "text", text: "123456" }, { type: "text", text: "10" }] }]);
});

test("buildTemplatePayload omits components for a template without variables", () => {
  const p = buildTemplatePayload({ ...positional, components: [{ type: "BODY", text: "Hello" }] });
  assert.deepEqual(p, { name: "otp", language: { code: "en" } });
});

test("buildTemplatePayload rejects missing, unknown, empty and malformed variables", () => {
  assert.throws(() => buildTemplatePayload(named, { variables: { first_name: "Ali" } }), (e) => e instanceof TemplateError && e.details.missing.includes("order_id"));
  assert.throws(() => buildTemplatePayload(positional, { variables: { 1: "a", 2: "b", 3: "c" } }), /unknown template variables: 3/);
  assert.throws(() => buildTemplatePayload(positional, { variables: { 1: " ", 2: "b" } }), /must not be empty/);
  assert.throws(() => buildTemplatePayload(positional, { variables: { 1: "a\tb", 2: "b" } }), /tabs/);
  assert.throws(() => buildTemplatePayload(positional, { variables: { 1: "x".repeat(1025), 2: "b" } }), /exceeds/);
  assert.throws(() => buildTemplatePayload(positional, { variables: { 1: { a: 1 }, 2: "b" } }), /string or number/);
  assert.throws(() => buildTemplatePayload(positional, { variables: [] }), /must be an object/);
});

test("buildTemplatePayload refuses templates that are not approved", () => {
  for (const status of ["draft", "pending", "rejected", "paused", "disabled"]) {
    assert.throws(() => buildTemplatePayload({ ...positional, status }, { variables: { 1: "a", 2: "b" } }), /not approved/);
  }
});

test("positional placeholders with gaps are rejected", () => {
  const gap = { ...positional, components: [{ type: "BODY", text: "{{1}} and {{3}}" }] };
  assert.throws(() => buildTemplatePayload(gap, { variables: { 1: "a", 3: "c" } }), /without gaps/);
});

test("media headers require an https link", () => {
  const media = { ...positional, header_format: "image", components: [{ type: "HEADER", format: "IMAGE" }, { type: "BODY", text: "Hi" }] };
  assert.throws(() => buildTemplatePayload(media, {}), /header_media.link/);
  assert.throws(() => buildTemplatePayload(media, { header_media: { link: "http://x.test/a.png" } }), /header_media.link/);
  const p = buildTemplatePayload(media, { header_media: { link: "https://cdn.example.com/a.png" } });
  assert.deepEqual(p.components, [{ type: "header", parameters: [{ type: "image", image: { link: "https://cdn.example.com/a.png" } }] }]);
  assert.throws(() => buildTemplatePayload(positional, { variables: { 1: "a", 2: "b" }, header_media: { link: "https://x.test/a.png" } }), /no media header/);
});

test("mapMetaTemplateStatus", () => {
  assert.equal(mapMetaTemplateStatus("APPROVED"), "approved");
  assert.equal(mapMetaTemplateStatus("rejected"), "rejected");
  assert.equal(mapMetaTemplateStatus("PAUSED"), "paused");
  assert.equal(mapMetaTemplateStatus("PENDING_DELETION"), "disabled");
  assert.equal(mapMetaTemplateStatus("SOMETHING_NEW"), null);
  assert.equal(mapMetaTemplateStatus(undefined), null);
});

test("renderTemplateText fills known variables and keeps unknown placeholders", () => {
  assert.equal(renderTemplateText(named, { first_name: "Ali", order_id: "A-1" }), "Hi Ali, order A-1 ships {{ship_date}}.");
  assert.equal(renderTemplateText(positional, { 1: "999" }), "Code 999 expires in {{2}} minutes. 999");
});
