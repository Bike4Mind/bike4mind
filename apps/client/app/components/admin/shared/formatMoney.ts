/**
 * The one formatter for money in the admin (DESIGN_GUIDE "Money"). Amounts arrive in minor units with
 * Stripe's lowercase currency code. React-free, so server code such as CSV export can share it.
 */

const LOCALE = 'en-US';
// Past this many major units a StatTile value switches to compact notation ("$12.3K").
const COMPACT_FROM = 10_000;

/** Digits after the decimal point for `currency`: 2 for USD, 0 for JPY. */
export const moneyFractionDigits = (currency: string): number =>
  new Intl.NumberFormat(LOCALE, { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;

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
      maximumFractionDigits: 1,
    }).format(amount);
  }
  return new Intl.NumberFormat(LOCALE, { style: 'currency', currency }).format(amount);
}
