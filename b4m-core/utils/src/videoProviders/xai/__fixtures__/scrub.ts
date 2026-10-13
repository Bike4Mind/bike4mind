// Pure helpers for record.ts; kept separate so the redaction rules are unit-tested.
import { assertNoSecret, scrubBody } from '../../geminiOmni/__fixtures__/scrub';

export { assertNoSecret };

const DATA_URI = /^data:[^,]*,/;

/**
 * Scrubs a recorded body: pre-signed URL queries are dropped (the signature is a credential), and a data URI
 * (the submitted image) is replaced by its length, so no image bytes are committed.
 */
export const scrubXaiBody = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(scrubXaiBody);
  if (typeof value === 'string') return DATA_URI.test(value) ? `<redacted:data-uri ${value.length} chars>` : value;
  if (typeof value !== 'object' || value === null) return value;
  const entries = Object.entries(value).map(([key, inner]): [string, unknown] => [key, scrubXaiBody(inner)]);
  return scrubBody(Object.fromEntries(entries));
};
