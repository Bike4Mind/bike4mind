/**
 * Pure math behind the Adjust credits dialog. Mirrors the server's rules in
 * `b4m-core/services/src/userService/adminUpdate.ts`: a set is an absolute target, and a deduction
 * never drives the balance below zero.
 */

export type CreditAdjustmentMode = 'set' | 'add' | 'subtract';

export const CREDIT_ADJUSTMENT_MODES: readonly { mode: CreditAdjustmentMode; label: string; amountLabel: string }[] = [
  { mode: 'set', label: 'Set to', amountLabel: 'New balance' },
  { mode: 'add', label: 'Add', amountLabel: 'Credits to add' },
  { mode: 'subtract', label: 'Subtract', amountLabel: 'Credits to remove' },
];

/** Client-side cap on a balance or a delta; the update endpoint does not bound either yet. */
export const MAX_CREDIT_AMOUNT = 1_000_000_000;

export const CREDIT_AMOUNT_HINT = 'Enter a whole number of credits, 0 or more.';

/** A whole, non-negative amount within the server's bound, or null for anything else. */
export const parseCreditAmount = (raw: string): number | null => {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const amount = Number(trimmed);
  return amount <= MAX_CREDIT_AMOUNT ? amount : null;
};

export type CreditAdjustment = { before: number; after: number; delta: number };

export const computeCreditAdjustment = (
  balance: number,
  mode: CreditAdjustmentMode,
  amount: number
): CreditAdjustment => {
  const after =
    mode === 'set' ? amount : mode === 'add' ? balance + amount : balance - Math.min(amount, Math.max(balance, 0));
  return { before: balance, after, delta: after - balance };
};

/**
 * The `PUT /api/users/[id]/update` fields for an adjustment. A set goes as an absolute
 * `currentCredits` so the server computes the delta from its own fresh read; add and subtract go as
 * `creditDelta` so concurrent spend is never refunded.
 */
export const creditAdjustmentPayload = (
  mode: CreditAdjustmentMode,
  amount: number
): { currentCredits: number } | { creditDelta: number } => {
  if (mode === 'set') return { currentCredits: amount };
  return { creditDelta: mode === 'add' ? amount : -amount };
};

export const formatCredits = (value: number): string => value.toLocaleString('en-US');

/** "+2,000", "\u2212412" (U+2212, a real minus sign) or "No change". */
export const formatCreditDelta = (delta: number): string => {
  if (delta === 0) return 'No change';
  return `${delta > 0 ? '+' : '\u2212'}${formatCredits(Math.abs(delta))}`;
};
