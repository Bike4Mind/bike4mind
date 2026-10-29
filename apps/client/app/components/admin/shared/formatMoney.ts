/**
 * The one formatter for money in the admin (DESIGN_GUIDE "Money"). Amounts arrive in minor units with
 * Stripe's lowercase currency code. React-free, so server code such as CSV export can share it.
 */

const LOCALE = 'en-US';
// Past this many major units a StatTile value switches to compact notation ("$12.3K").
const COMPACT_FROM = 10_000;

// Stripe's minor-unit exponents; Intl's display digits differ for HUF, ISK and IDR.
const ZERO_DECIMAL = new Set('bif clp djf gnf jpy kmf krw mga pyg rwf ugx vnd vuv xaf xof xpf'.split(' '));
const THREE_DECIMAL = new Set(['bhd', 'jod', 'kwd', 'omr', 'tnd']);

/** Digits in a minor unit of `currency`, as Stripe sends it: 2 for USD, 0 for JPY, 3 for KWD. */
export const moneyFractionDigits = (currency: string): number => {
  const code = currency.toLowerCase();
  if (ZERO_DECIMAL.has(code)) return 0;
  return THREE_DECIMAL.has(code) ? 3 : 2;
};

export const toMajorUnits = (minorUnits: number, currency: string): number =>
  minorUnits / 10 ** moneyFractionDigits(currency);

/** "$1,234.56", "-$12.00", "CA$19.00"; with `compact`, "$12.3K" from 10,000 major units. */
export function formatMoney(minorUnits: number, currency: string, { compact = false }: { compact?: boolean } = {}) {
  const amount = toMajorUnits(minorUnits, currency);
  if (compact && Math.abs(amount) >= COMPACT_FROM) {
    return new Intl.NumberFormat(LOCALE, {
      style: 'currency',
      currency,
      notation: 'compact',
      minimumFractionDigits: 0,
      maximumFractionDigits: 1,
    }).format(amount);
  }
  const digits = moneyFractionDigits(currency);
  return new Intl.NumberFormat(LOCALE, {
    style: 'currency',
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(amount);
}
