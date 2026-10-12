const plural = (n: number) => (n === 1 ? 'credit' : 'credits');

/**
 * A credit count with en-US grouping ("50,000"), whatever the browser locale: the app copy is
 * English, and a bare toLocaleString() put "50.000" beside "9,951 credits" for a Spanish browser.
 */
export const formatCreditAmount = (credits: number): string => credits.toLocaleString('en-US');

/** Screen-reader name for a one-time credit pack button, shared by both credits dialogs. */
export const purchaseCreditsAriaLabel = (credits: number, priceDollars: number): string =>
  `Purchase ${formatCreditAmount(credits)} credits for $${priceDollars}`;

// Below this, `compact` still shows every digit: abbreviating 9,903 to "9.9K" hid single-answer spends.
const COMPACT_FROM = 100_000;

/** A balance: "9,982 credits", or "124.5K credits" when `compact` and 100,000 or more. Fractions round down, negatives show 0. */
export function formatCreditBalance(credits: number, compact = false): string {
  const whole = Math.max(0, Math.floor(credits));
  const num =
    compact && whole >= COMPACT_FROM
      ? new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(whole)
      : whole.toLocaleString('en-US');
  return `${num} ${plural(whole)}`;
}

/**
 * What one answer cost: "15 credits". Pricing has no 1-credit minimum (b4m-core pricing.ts), so a
 * cheap answer can cost a fraction - shown as "<1 credit" rather than rounded down to a false 0.
 */
export function formatAnswerCost(credits: number): string {
  if (credits > 0 && credits < 1) return '<1 credit';
  const whole = Math.max(0, Math.round(credits));
  return `${whole.toLocaleString('en-US')} ${plural(whole)}`;
}
