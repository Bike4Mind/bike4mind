import { readAcquisitionCookies } from '@client/lib/subscriptions/acquisition';
import { resolveConsent } from './consentRegion';

function readCookie(name: string): string | undefined {
  const entry = document.cookie.split('; ').find(cookie => cookie.startsWith(`${name}=`));
  if (!entry) return undefined;
  try {
    return decodeURIComponent(entry.slice(name.length + 1));
  } catch {
    // Malformed percent encoding carries no attribution.
    return undefined;
  }
}

/** Stamp conversion pixels with the same consent-gated touches checkout records. */
export function attributionParams(sessionUtmSuffix: string): Record<string, string> {
  if (typeof document === 'undefined' || resolveConsent() !== 'granted') return {};
  const { firstTouch, lastTouch } = readAcquisitionCookies(readCookie);
  const params: Record<string, string> = {};
  for (const field of ['source', 'medium', 'campaign'] as const) {
    const firstValue = firstTouch?.[field];
    const lastValue = lastTouch?.[field];
    if (firstValue) params[`first_touch_${field}`] = firstValue;
    if (lastValue) params[`utm_${field}_at_${sessionUtmSuffix}`] = lastValue;
  }
  return params;
}
