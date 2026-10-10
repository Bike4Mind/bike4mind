const plural = (n: number) => (n === 1 ? 'credit' : 'credits');

/** A balance: "9,982 credits", or "10K credits" when `compact`. Fractions round down, negatives show 0. */
export function formatCreditBalance(credits: number, compact = false): string {
  const whole = Math.max(0, Math.floor(credits));
  const num = compact
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
