import { COMPLETION_RUN_MAX_BUDGET_CREDITS } from '@bike4mind/common';

/**
 * Read a credit budget typed by the user. `null` for a blank field (no budget), `undefined` for
 * anything that is not a whole number of credits in range. Commas are allowed as grouping.
 */
export function parseBudgetCredits(text: string): number | null | undefined {
  const trimmed = text.replace(/,/g, '').trim();
  if (trimmed === '') return null;
  if (!/^\d+$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return value >= 1 && value <= COMPLETION_RUN_MAX_BUDGET_CREDITS ? value : undefined;
}
