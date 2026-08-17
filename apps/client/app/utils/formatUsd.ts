/**
 * USD with enough precision that small COGS stays visible: 2dp at/above $1,
 * 4dp below, and a floor marker so a sub-rounding amount isn't shown as $0.00.
 */
export const formatUsd = (n: number): string => {
  if (n <= 0) return '$0.00';
  if (n < 0.0001) return '<$0.0001';
  return `$${n.toFixed(n < 1 ? 4 : 2)}`;
};
