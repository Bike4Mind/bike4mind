/** Right-aligned numeric table cells line up when digits are tabular. */
export const numberCell = { fontVariantNumeric: 'tabular-nums' } as const;

/**
 * Credits as whole numbers, but never let a real, sub-1 amount read as "0" -
 * fractional credits (e.g. cache-read discounts) would otherwise look like no spend.
 */
export const formatCredits = (n: number): string => {
  if (n <= 0) return '0';
  if (n < 1) return '<1';
  return Math.round(n).toLocaleString();
};

/**
 * USD with enough precision that small COGS stays visible: 2dp at/above $1,
 * 4dp below, and a floor marker so a sub-rounding amount isn't shown as $0.00.
 */
export const formatUsd = (n: number): string => {
  if (n <= 0) return '$0.00';
  if (n < 0.0001) return '<$0.0001';
  return `$${n.toFixed(n < 1 ? 4 : 2)}`;
};
