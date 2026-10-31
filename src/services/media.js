import * as repo from "../db/repo.js";
import { decryptSecret } from "../lib/crypto.js";
import { AppError, notFound } from "../lib/errors.js";
import { MetaApiError } from "../meta/client.js";

const SAFE_TYPE = /^[a-z]+\/[a-z0-9.+-]+$/i;

/** Fetches the media of an inbound message from Meta on the tenant's behalf. */
export function createMediaService({ db, meta, encryptionKey }) {
  return {
    async download(auth, messageId) {
      const m = await repo.getMessage(db, auth.tenant_id, messageId);
      if (!m || m.direction !== "inbound" || !m.content?.media_id) throw notFound("No media for this message");
      if (auth.waba_connection_id && m.waba_connection_id !== auth.waba_connection_id) throw notFound("No media for this message");
      const conn = await repo.getWabaConnection(db, auth.tenant_id, m.waba_connection_id);
      if (!conn) throw notFound("No media for this message");
      const token = decryptSecret(conn.token_cipher, encryptionKey, conn.id);
      try {
        const info = await meta.getMediaInfo({ mediaId: m.content.media_id, token });
        const file = await meta.downloadMedia({ url: info?.url, token });
        const declared = String(m.content.mime_type || info?.mime_type || file.contentType).split(";")[0].trim();
        return { body: file.body, contentType: SAFE_TYPE.test(declared) ? declared : "application/octet-stream", filename: m.content.filename ?? null };
      } catch (err) {
        if (err instanceof MetaApiError) {
          // Meta keeps inbound media for a limited time; expired ids return 4xx.
          if (err.status >= 400 && err.status < 500) throw new AppError(410, "media_unavailable", "The media is no longer available from WhatsApp");
          throw new AppError(502, "media_fetch_failed", "Could not fetch the media from WhatsApp");
        }
        throw err;
      }
    },
  };
}
