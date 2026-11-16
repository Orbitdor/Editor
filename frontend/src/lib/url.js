/**
 * Accept only addresses that are safe to put in an href/src.
 *
 * Returns the normalised URL, or an empty string when the value is not a
 * web/mail/tel address. Callers translate "" into an error message so the
 * dialog can stay open instead of silently inserting a broken link.
 */
export function normalizeUrl(raw, { image = false } = {}) {
  const value = String(raw || "").trim();
  if (!value) return "";
  if (!image && (value.startsWith("/") || value.startsWith("#"))) return value;
  if (!image && /^(mailto:|tel:)/i.test(value)) return value;

  const withProtocol = /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`;
  try {
    const url = new URL(withProtocol);
    if (!["http:", "https:"].includes(url.protocol)) return "";
    return url.toString();
  } catch {
    return "";
  }
}
