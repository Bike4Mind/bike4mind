/**
 * Parse a raw test-email textarea value into a normalized, deduped address list.
 * Splitting/filtering matches the prior inline logic; adds trim+lowercase
 * normalization and order-preserving dedupe so the UI count, the payload, and
 * the server send all agree on distinct inboxes.
 */
export function parseTestEmailAddresses(raw: string): string[] {
  const seen = new Set<string>();
  return raw
    .split(/[\n,]+/)
    .map(e => e.trim().toLowerCase())
    .filter(e => e.includes('@') && !seen.has(e) && seen.add(e)); // '@' implies non-empty
}
