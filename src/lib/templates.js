// Message templates: variable extraction and building the Cloud API
// `template` object from caller-supplied variables.
const NAME = /^[a-z0-9_]+$/;
const NAMED_VAR = /\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g;
const POSITIONAL_VAR = /\{\{\s*([1-9][0-9]*)\s*\}\}/g;
export const MEDIA_HEADER_FORMATS = Object.freeze(["image", "video", "document"]);
export const MAX_PARAM_LENGTH = 1024;

export function isValidTemplateName(name) {
  return typeof name === "string" && name.length > 0 && name.length <= 512 && NAME.test(name);
}

/** Meta template statuses -> stored status. Unknown values return null. */
export function mapMetaTemplateStatus(status) {
  const map = {
    APPROVED: "approved",
    REJECTED: "rejected",
    PENDING: "pending",
    IN_APPEAL: "pending",
    PAUSED: "paused",
    DISABLED: "disabled",
    PENDING_DELETION: "disabled",
    DELETED: "disabled",
    REINSTATED: "approved",
    FLAGGED: "approved", // still sendable; quality warning only
  };
  return map[String(status || "").toUpperCase()] ?? null;
}

function componentText(components, type) {
  const c = (components || []).find((x) => String(x?.type).toUpperCase() === type);
  return c && typeof c.text === "string" ? c.text : "";
}

function varsIn(text, format) {
  const re = format === "positional" ? POSITIONAL_VAR : NAMED_VAR;
  const seen = [];
  for (const m of text.matchAll(re)) if (!seen.includes(m[1])) seen.push(m[1]);
  if (format === "positional") seen.sort((a, b) => Number(a) - Number(b));
  return seen;
}

/** Variables used by the header and body text, in send order. */
export function extractVariables(components, format = "named") {
  return {
    header: varsIn(componentText(components, "HEADER"), format),
    body: varsIn(componentText(components, "BODY"), format),
  };
}

function checkPositionalSequence(list, where) {
  list.forEach((v, i) => {
    if (Number(v) !== i + 1) throw new TemplateError(`${where} placeholders must be numbered {{1}}..{{n}} without gaps`);
  });
}

export class TemplateError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "TemplateError";
    this.details = details;
  }
}

function paramValue(name, variables) {
  const v = variables?.[name];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" && typeof v !== "number") throw new TemplateError(`variable "${name}" must be a string or number`);
  const s = String(v);
  if (!s.trim()) throw new TemplateError(`variable "${name}" must not be empty`);
  if (s.length > MAX_PARAM_LENGTH) throw new TemplateError(`variable "${name}" exceeds ${MAX_PARAM_LENGTH} characters`);
  if (/\n{3,}|\t| {5,}/.test(s)) throw new TemplateError(`variable "${name}" contains new lines, tabs or more than 4 consecutive spaces`);
  return s;
}

/**
 * Builds the Cloud API `template` object.
 * @param template stored template row (name, language, status, components, parameter_format, header_format)
 * @param input { variables?: object, header_media?: { link } }
 */
export function buildTemplatePayload(template, input = {}) {
  if (template.status !== "approved") throw new TemplateError(`template "${template.name}" is ${template.status}, not approved`);
  const format = template.parameter_format === "positional" ? "positional" : "named";
  const { header, body } = extractVariables(template.components, format);
  if (format === "positional") {
    checkPositionalSequence(header, "header");
    checkPositionalSequence(body, "body");
  }
  const variables = input.variables ?? {};
  if (typeof variables !== "object" || Array.isArray(variables)) throw new TemplateError("variables must be an object");

  const required = [...new Set([...header, ...body])];
  const missing = required.filter((n) => paramValue(n, variables) === undefined);
  if (missing.length) throw new TemplateError(`missing template variables: ${missing.join(", ")}`, { missing });
  const unknown = Object.keys(variables).filter((k) => !required.includes(k));
  if (unknown.length) throw new TemplateError(`unknown template variables: ${unknown.join(", ")}`, { unknown });

  const param = (n) =>
    format === "named" ? { type: "text", parameter_name: n, text: paramValue(n, variables) } : { type: "text", text: paramValue(n, variables) };

  const components = [];
  const headerFormat = String(template.header_format || "none").toLowerCase();
  if (MEDIA_HEADER_FORMATS.includes(headerFormat)) {
    const link = input.header_media?.link;
    if (!isHttpsUrl(link)) throw new TemplateError(`template "${template.name}" needs header_media.link (https URL) for its ${headerFormat} header`);
    components.push({ type: "header", parameters: [{ type: headerFormat, [headerFormat]: { link } }] });
  } else if (header.length) {
    components.push({ type: "header", parameters: header.map(param) });
  } else if (input.header_media) {
    throw new TemplateError(`template "${template.name}" has no media header`);
  }
  if (body.length) components.push({ type: "body", parameters: body.map(param) });

  return { name: template.name, language: { code: template.language }, ...(components.length ? { components } : {}) };
}

/** Renders a template body with variables for previews and stored message content. */
export function renderTemplateText(template, variables = {}) {
  const format = template.parameter_format === "positional" ? "positional" : "named";
  const re = format === "positional" ? POSITIONAL_VAR : NAMED_VAR;
  return componentText(template.components, "BODY").replace(re, (_, n) => (variables[n] !== undefined ? String(variables[n]) : `{{${n}}}`));
}

export function isHttpsUrl(value) {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const u = new URL(value);
    return u.protocol === "https:" && Boolean(u.hostname);
  } catch {
    return false;
  }
}
