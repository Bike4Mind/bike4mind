/** Dollar price for display: whole amounts drop the cents ("$30"), others keep two places ("$12.50"). */
export function formatPlanPrice(dollars: number): string {
  return Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`;
}

/** Dollar cost of 1,000 credits at a pack's price, to the cent ("$0.60"). */
export function pricePerThousandCredits(priceDollars: number, credits: number): string {
  return `$${((priceDollars / credits) * 1000).toFixed(2)}`;
}

/**
 * The per-1,000 rate shared by every pack, or null when the packs are priced at different rates
 * (then each pack shows its own). Computed from the package table, never asserted.
 */
export function sharedPackRate(packs: ReadonlyArray<{ price: number; credits: number }>): string | null {
  const rates = new Set(packs.map(pack => pricePerThousandCredits(pack.price, pack.credits)));
  return rates.size === 1 ? [...rates][0] : null;
}
