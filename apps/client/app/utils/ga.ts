const GA_NUMERIC_ID_RE = /^(?:properties\/)?(\d+)$/;

export function buildGADashboardUrl(gaPropertyId: string | undefined | null): string | null {
  if (!gaPropertyId) return null;
  const match = gaPropertyId.trim().match(GA_NUMERIC_ID_RE);
  if (!match) return null;
  return `https://analytics.google.com/analytics/web/#/p${match[1]}/reports/reportinghub`;
}
