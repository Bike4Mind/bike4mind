const plural = (n: number) => (n === 1 ? 'credit' : 'credits');

/**
 * A credit count with en-US grouping ("50,000"), whatever the browser locale: the app copy is
 * English, and a bare toLocaleString() put "50.000" beside "9,951 credits" for a Spanish browser.
 */
export const formatCreditAmount = (credits: number): string => credits.toLocaleString('en-US');

/** Screen-reader name for a one-time credit pack button, shared by both credits dialogs. */
export const purchaseCreditsAriaLabel = (credits: number, priceDollars: number): string =>
  `Purchase ${formatCreditAmount(credits)} credits for $${priceDollars}`;

/** A balance: "9,982 credits". Fractions round down, negatives show 0. */
export function formatCreditBalance(credits: number): string {
  const whole = Math.max(0, Math.floor(credits));
  return `${whole.toLocaleString('en-US')} ${plural(whole)}`;
}

/**
 * An answer's cost as a bare number: "15", "1,234". Pricing has no 1-credit minimum (b4m-core
 * pricing.ts), so a cheap answer can cost a fraction - shown as "<1" rather than a false 0.
 */
export function formatAnswerCostAmount(credits: number): string {
  if (credits > 0 && credits < 1) return '<1';
  return Math.max(0, Math.round(credits)).toLocaleString('en-US');
}

/** The unit that reads after formatAnswerCostAmount: "credit" for "<1" and 1, else "credits". */
export function answerCostUnit(credits: number): string {
  return credits > 0 && credits < 1 ? 'credit' : plural(Math.max(0, Math.round(credits)));
}

/** What one answer cost, labelled: "15 credits", "<1 credit". */
export function formatAnswerCost(credits: number): string {
  return `${formatAnswerCostAmount(credits)} ${answerCostUnit(credits)}`;
}
