/**
 * Redaction for debug/spike output.
 *
 * The brief (section 10) requires that tokens, keys, cookies, session ids and
 * anything password-like never land in saved logs or diagnostic reports. This
 * runs over every captured WebSocket frame before it is written to disk.
 */

const SENSITIVE_KEY = /(session|token|password|passwd|secret|cookie|auth|uid|user_?id|balance|email)/i;

/** Long hex / base64-ish blobs that look like credentials even without a key name. */
const SECRET_BLOB = /\b[A-Za-z0-9_-]{24,}\b/g;

const MASK = '«redacted»';

/**
 * Recursively mask sensitive fields in a parsed JSON value. Structure and
 * event names are preserved so the frame is still analyzable.
 */
export function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? MASK : redactValue(v);
    }
    return out;
  }
  return value;
}

/**
 * Redact a raw text frame we could not parse as JSON: blank out long
 * credential-looking blobs so nothing sensitive survives.
 */
export function redactRawText(text: string): string {
  return text.replace(SECRET_BLOB, (m) => (m.length >= 24 ? MASK : m));
}
