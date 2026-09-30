import { z } from 'zod';

export const ACQUISITION_COOKIES = {
  marketingFirstTouch: 'b4m-first-touch',
  appFirstTouch: 'b4m_app_first_touch',
  lastTouch: 'b4m_last_touch',
  session: 'b4m_utm',
} as const;

export const ACQUISITION_FIELD_LIMIT = 128;

const normalizeField = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, ACQUISITION_FIELD_LIMIT) : undefined;

export const acquisitionTouchSchema = z.object({
  source: z.preprocess(normalizeField, z.string()),
  medium: z.preprocess(normalizeField, z.string().optional()),
  campaign: z.preprocess(normalizeField, z.string().optional()),
  content: z.preprocess(normalizeField, z.string().optional()),
});

export type AcquisitionTouch = z.infer<typeof acquisitionTouchSchema>;
export type AcquisitionTouches = { firstTouch?: AcquisitionTouch; lastTouch?: AcquisitionTouch };

function readTouch(raw: string | undefined): AcquisitionTouch | undefined {
  if (!raw) return undefined;
  try {
    const parsed = acquisitionTouchSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    // Cookies are untrusted input; malformed JSON carries no attribution.
    return undefined;
  }
}

/** Shared by checkout and conversion pixels so precedence and field limits agree. */
export function readAcquisitionCookies(readCookie: (name: string) => string | undefined): AcquisitionTouches {
  const firstTouch =
    readTouch(readCookie(ACQUISITION_COOKIES.marketingFirstTouch)) ??
    readTouch(readCookie(ACQUISITION_COOKIES.appFirstTouch));
  const lastTouch =
    readTouch(readCookie(ACQUISITION_COOKIES.lastTouch)) ?? readTouch(readCookie(ACQUISITION_COOKIES.session));
  return { ...(firstTouch && { firstTouch }), ...(lastTouch && { lastTouch }) };
}
