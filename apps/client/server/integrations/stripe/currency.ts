/**
 * Stripe reports amounts in the currency's minor unit; GA4 and the ad pixels want
 * major units. Most currencies are two-decimal, but Stripe has zero-decimal
 * currencies (JPY, KRW, VND, ...) where the "minor" unit IS the major unit, so
 * dividing by 100 would under-report revenue 100x, and three-decimal currencies
 * (BHD, KWD, ...) where amount_total is thousandths, so dividing by 100 would
 * over-report 10x. Since `currency` is echoed dynamically from the session, the
 * divisor has to follow it.
 * @see https://docs.stripe.com/currencies#zero-decimal
 * @see https://docs.stripe.com/currencies#three-decimal
 */
const ZERO_DECIMAL_CURRENCIES = new Set([
  'bif',
  'clp',
  'djf',
  'gnf',
  'jpy',
  'kmf',
  'krw',
  'mga',
  'pyg',
  'rwf',
  'ugx',
  'vnd',
  'vuv',
  'xaf',
  'xof',
  'xpf',
]);

// amount_total is in thousandths; Stripe still charges these rounded to hundredths.
const THREE_DECIMAL_CURRENCIES = new Set(['bhd', 'jod', 'kwd', 'omr', 'tnd']);

/** Minor units per major unit for a Stripe currency code (lowercase). */
export function minorUnitsPerMajor(currency: string): number {
  const code = currency.toLowerCase();
  if (ZERO_DECIMAL_CURRENCIES.has(code)) return 1;
  if (THREE_DECIMAL_CURRENCIES.has(code)) return 1000;
  return 100;
}
