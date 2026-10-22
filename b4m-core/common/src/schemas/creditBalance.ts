import { z } from 'zod';

/**
 * Public wire schema for the caller's spendable balance. Served on its own by
 * `GET /api/v1/credits` and embedded as `credits` in `GET /api/v1/me`, so the two
 * endpoints cannot describe the balance differently.
 */
export const CreditBalanceSchema = z.object({
  /**
   * Spendable credits on the caller's PERSONAL ledger. Organization pools are not
   * included - a call billed to an organization draws on a balance this number
   * does not describe.
   */
  balance: z.number(),
});

export type CreditBalance = z.infer<typeof CreditBalanceSchema>;
