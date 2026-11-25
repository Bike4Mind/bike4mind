import type { BillingPayer } from '@shared/account';

export const PERSONAL_PAYER: BillingPayer = Object.freeze({ organization_id: null });

let source: () => BillingPayer = () => PERSONAL_PAYER;
let ready: Promise<unknown> = Promise.resolve();

/**
 * Main's one answer to "who pays for this call", wired to AccountSelectionService by
 * registerAccount. MediaApiClient and streamCompletion read it per request, never at construction,
 * so a switch applies to the very next submit wherever the client was built.
 */
export function setBillingPayerSource(next: () => BillingPayer, loaded: Promise<unknown> = Promise.resolve()): void {
  source = next;
  ready = loaded;
}

/** Waits for the remembered pick to load, so a submit at startup never bills Personal by default. */
export async function currentBillingPayer(): Promise<BillingPayer> {
  await ready;
  return source();
}
