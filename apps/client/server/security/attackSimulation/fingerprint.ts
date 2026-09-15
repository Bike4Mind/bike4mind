import type { SecurityFindingCategory } from '@bike4mind/database';

/**
 * Deterministic fingerprint for a finding. Stable across runs so the same vulnerability
 * always maps to the same document.
 *
 * Inputs must be free of volatile data (timestamps, counts, runIds, status codes). Because
 * the fingerprint is `category::endpoint::title`, varying any of those three varies the
 * fingerprint - so to distinguish two near-identical findings, vary the **endpoint** or
 * **category**. Keep titles stable across runs of the same probe.
 */
export function buildFingerprint(category: SecurityFindingCategory, endpoint: string, title: string): string {
  return `${category}::${endpoint.trim()}::${title.trim()}`;
}
