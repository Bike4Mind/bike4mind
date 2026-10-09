// Pure helpers for record.ts; kept separate so the redaction rules are unit-tested.
export const scrubUrl = (raw: string): string => {
  try {
    const url = new URL(raw);
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return raw;
  }
};

const looksLikeUrl = (value: string): boolean => /^https?:\/\//.test(value);

export const scrubBody = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(scrubBody);
  if (typeof value === 'string') return looksLikeUrl(value) ? scrubUrl(value) : value;
  if (typeof value !== 'object' || value === null) return value;
  const entries = Object.entries(value).map(([key, inner]): [string, unknown] => {
    if ((key === 'data' || key === 'bytesBase64Encoded') && typeof inner === 'string')
      return [key, `<redacted:base64 ${inner.length} chars>`];
    return [key, scrubBody(inner)];
  });
  return Object.fromEntries(entries);
};

export const assertNoSecret = (serialized: string, secret: string): void => {
  if (secret.length > 0 && serialized.includes(secret)) throw new Error('fixture contains the API key; not writing it');
};
