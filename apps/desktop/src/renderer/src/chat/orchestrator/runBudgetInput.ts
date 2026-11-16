/** The largest budget the server accepts; mirrors COMPLETION_RUN_MAX_BUDGET_CREDITS in @bike4mind/common. */
export const MAX_RUN_BUDGET_CREDITS = 1_000_000_000;

/**
 * Read a credit budget typed by the user. `null` for a blank field (no budget), `undefined` for
 * anything that is not a whole number of credits in range. Commas are allowed as grouping.
 */
export function parseBudgetCredits(text: string): number | null | undefined {
  const trimmed = text.replace(/,/g, '').trim();
  if (trimmed === '') return null;
  if (!/^\d+$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return value >= 1 && value <= MAX_RUN_BUDGET_CREDITS ? value : undefined;
}
