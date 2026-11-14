// Evidence leaves the page only after this pass. Credentials in URLs, headers, bodies, storage and
// console text are replaced; nothing is uploaded until a person reviews it, but the local notebook
// should not hold secrets either.
export const SENSITIVE = /authorization|cookie|password|passwd|secret|token|api.?key|session.?id|credential|csrf|xsrf/i;
/** Query keys that carry credentials in signed or OAuth URLs, beyond the general list. */
const SENSITIVE_QUERY = /^(code|state|sig|signature|key|auth|jwt|otp)$|^x-(amz|goog)-/i;
export const REDACTED = '[REDACTED]';
const MAX_TEXT = 16 * 1024;

export function sanitizeUrl(input: string): string {
  try {
    const url = new URL(input);
    url.username = '';
    url.password = '';
    url.hash = '';
    for (const [key, value] of [...url.searchParams.entries()]) {
      const clean = SENSITIVE.test(key) || SENSITIVE_QUERY.test(key) ? REDACTED : sanitizeText(value);
      if (clean !== value) url.searchParams.set(key, clean);
    }
    // Content rules over the whole URL too: tokens also travel in paths.
    return sanitizeText(url.toString());
  } catch {
    return sanitizeText(input);
  }
}

export function sanitizeText(text: string): string {
  return redactContent(text.slice(0, MAX_TEXT));
}

/**
 * The content rules without the length cap, for text that must stay whole (DOM recordings). Every
 * pattern is linear: the one open-ended prefix starts at a word boundary and is bounded, so a long
 * run of word characters cannot make it backtrack quadratically.
 */
export function redactContent(text: string): string {
  return text
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi, `$1 ${REDACTED}`)
    .replace(
      /((?:authorization|cookie|password|passwd|secret|\b[\w-]{0,64}?token|api[_-]?key|session[_-]?id|csrf|xsrf)\s{0,8}["']?\s{0,8}[:=]\s{0,8}["']?)[^\s"'&,;}]+/gi,
      `$1${REDACTED}`,
    )
    // Signed-URL and OAuth query keys wherever a URL sits inside text: CSS url(), srcset, scripts.
    .replace(/([?&;](?:code|state|sig|signature|key|auth|jwt|otp|x-(?:amz|goog)-[\w-]{1,40})=)[^&\s"'#)]+/gi, `$1${REDACTED}`)
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, REDACTED)
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, REDACTED);
}

export function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 7) return '[OMITTED: depth limit]';
  if (typeof value === 'string') return /^https?:\/\//.test(value) ? sanitizeUrl(value) : sanitizeText(value);
  if (Array.isArray(value)) return value.slice(0, 80).map((item) => sanitize(item, depth + 1));
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    // Header and cookie lists: { name, value } pairs whose name is sensitive.
    if (typeof record.name === 'string' && SENSITIVE.test(record.name) && 'value' in record) {
      return { name: sanitizeText(record.name), value: REDACTED };
    }
    return Object.fromEntries(
      Object.entries(record)
        .slice(0, 80)
        .map(([key, v]) => [key, SENSITIVE.test(key) ? REDACTED : sanitize(v, depth + 1)]),
    );
  }
  return value;
}

/** A response body, or the reason it was left out. */
export function bodyEvidence(body: string, mimeType: string, url: string, pageUrl: string): Record<string, unknown> {
  try {
    if (new URL(url).origin !== new URL(pageUrl).origin) return { omission: 'Response body outside the page origin' };
  } catch {
    return { omission: 'Response URL unavailable' };
  }
  if (new TextEncoder().encode(body).length > MAX_TEXT) return { omission: 'Response body exceeds 16 KiB' };
  if (!/json|text\/plain|javascript|text\/css/.test(mimeType)) return { omission: 'Binary or document body left out' };
  try {
    return { format: 'json', body: sanitize(JSON.parse(body)) };
  } catch {
    return { format: 'text', body: sanitizeText(body) };
  }
}
