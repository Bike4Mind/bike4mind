export type PayerAccount = { name: string; personal: boolean };

/**
 * Names who pays for a generation, worded like the web's
 * (apps/client/app/hooks/data/generationBillingTarget.ts) so both apps say the same thing.
 */
export function payerLabel(account: PayerAccount | null): string | null {
  if (!account) return null;
  return account.personal ? 'your personal credits' : `${account.name} credits`;
}
