/**
 * Parse the lowercased `utm_campaign` value from a URL.
 * Returns null if the URL is malformed or has no utm_campaign param.
 */
export function extractUtmCampaign(url: string): string | null {
  try {
    const parsed = new URL(url);
    const value = parsed.searchParams.get('utm_campaign');
    const trimmed = value?.trim();
    return trimmed ? trimmed.toLowerCase() : null;
  } catch {
    return null;
  }
}
