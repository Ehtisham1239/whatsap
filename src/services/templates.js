import * as repo from "../db/repo.js";
import { decryptSecret } from "../lib/crypto.js";
import { notFound, unprocessable } from "../lib/errors.js";
import { extractVariables, isValidTemplateName, mapMetaTemplateStatus } from "../lib/templates.js";
import { MetaApiError } from "../meta/client.js";

/** Maps one Cloud API template object to a templates row, or null if unusable. */
export function templateRowFromMeta(t) {
  const category = String(t?.category || "").toLowerCase();
  const status = mapMetaTemplateStatus(t?.status);
  if (!isValidTemplateName(t?.name) || !t?.language || !status || !["marketing", "utility", "authentication"].includes(category)) return null;
  const components = Array.isArray(t.components) ? t.components : [];
  const parameterFormat = String(t.parameter_format || "positional").toLowerCase() === "named" ? "named" : "positional";
  const header = components.find((c) => String(c?.type).toUpperCase() === "HEADER");
  const vars = extractVariables(components, parameterFormat);
  return {
    name: t.name,
    language: String(t.language),
    category,
    status,
    components,
    variables: [...new Set([...vars.header, ...vars.body])],
    parameter_format: parameterFormat,
    header_format: header?.format ? String(header.format).toLowerCase() : "none",
    meta_id: t.id ? String(t.id) : null,
    reject_reason: t.rejected_reason && t.rejected_reason !== "NONE" ? String(t.rejected_reason) : null,
  };
}

export function createTemplateService({ db, meta, encryptionKey, now = () => new Date() }) {
  return {
    /** Pulls every template of the number's WABA from Meta and upserts them. */
    async sync(tenantId, wabaConnectionId) {
      const conn = await repo.getWabaConnection(db, tenantId, wabaConnectionId);
      if (!conn) throw notFound("WhatsApp number not found");
      let list;
      try {
        list = await meta.listTemplates({ wabaId: conn.waba_id, token: decryptSecret(conn.token_cipher, encryptionKey, conn.id) });
      } catch (err) {
        if (err instanceof MetaApiError) throw unprocessable("meta_error", `Could not fetch templates from WhatsApp: ${err.message}`);
        throw err;
      }
      const at = now();
      let synced = 0;
      let skipped = 0;
      await db.tx(async (q) => {
        for (const t of list) {
          const row = templateRowFromMeta(t);
          if (!row) {
            skipped++;
            continue;
          }
          await repo.upsertTemplate(q, { ...row, tenant_id: tenantId, waba_id: conn.waba_id, now: at });
          synced++;
        }
      });
      return { synced, skipped };
    },

    async list(tenantId, { status } = {}) {
      return (await repo.listTemplates(db, tenantId, { status })).map((t) => ({
        id: t.id,
        name: t.name,
        language: t.language,
        category: t.category,
        status: t.status,
        parameter_format: t.parameter_format,
        header_format: t.header_format,
        variables: t.variables,
        reject_reason: t.reject_reason,
        updated_at: new Date(t.updated_at).toISOString(),
      }));
    },
  };
}
