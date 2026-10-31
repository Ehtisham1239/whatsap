// Opaque keyset cursors: base64url JSON of the last row's (created_at, id).
export function encodeCursor(row) {
  if (!row) return null;
  return Buffer.from(JSON.stringify({ c: new Date(row.created_at).toISOString(), i: row.id })).toString("base64url");
}

export function decodeCursor(value) {
  if (!value) return null;
  try {
    const { c, i } = JSON.parse(Buffer.from(String(value), "base64url").toString("utf8"));
    const d = new Date(c);
    if (typeof i !== "string" || !/^[a-z]+_[0-9a-z]+$/.test(i) || Number.isNaN(d.getTime())) return undefined;
    return { created_at: d, id: i };
  } catch {
    return undefined;
  }
}
