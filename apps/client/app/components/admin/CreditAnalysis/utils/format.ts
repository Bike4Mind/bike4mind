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

// Re-exported for the existing admin call sites: formatUsd now lives in the shared
// app/utils, since the DataLakeWizard spend panel needs it too.
export { formatUsd } from '@client/app/utils/formatUsd';
