import { createHash } from 'node:crypto';
import { curatedKeyFromSeed, type CuratedKey } from '@bike4mind/local-models';

// The seed is public on purpose, so this key proves nothing. Must stay in sync with
// packages/scripts/src/curatedCatalog/devKey.ts, which refuses lists only this key signed and scans builds for it.
const CURATED_DEV_SEED_TEXT = 'b4m-model-hub-curated-test-key';

export function curatedDevKey(): CuratedKey {
  const { keyId, spki } = curatedKeyFromSeed(createHash('sha256').update(CURATED_DEV_SEED_TEXT).digest());
  return { keyId, spki, role: 'signing' };
}

export interface CuratedDevOverrides {
  keys: CuratedKey[];
  /** `B4M_CURATED_DEV_URL`, read at run time; null when unset. */
  url: string | null;
}

/**
 * The test key and URL override, for a build that compiled them in; never for a packaged app. Callers reach this
 * only behind `__B4M_CURATED_DEV_KEYS__`, so a release build drops this module and the seed with it.
 */
export function curatedDevOverrides(
  packaged: boolean,
  env: Record<string, string | undefined>
): CuratedDevOverrides | null {
  if (packaged) return null;
  return { keys: [curatedDevKey()], url: env.B4M_CURATED_DEV_URL?.trim() || null };
}
