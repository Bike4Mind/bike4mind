import { createHash } from 'node:crypto';
import { curatedKeyFromSeed, type CuratedKey, type CuratedKeyRole } from '@bike4mind/local-models';

// The seeds are public on purpose, so these keys prove nothing. Must stay in sync with
// packages/scripts/src/curatedCatalog/devKey.ts, which refuses lists only they signed and scans builds for them.
const CURATED_DEV_SEED_TEXTS: Record<CuratedKeyRole, string> = {
  signing: 'b4m-model-hub-curated-test-key',
  recovery: 'b4m-model-hub-curated-test-recovery-key',
};

export function curatedDevKey(role: CuratedKeyRole = 'signing'): CuratedKey {
  const { keyId, spki } = curatedKeyFromSeed(createHash('sha256').update(CURATED_DEV_SEED_TEXTS[role]).digest());
  return { keyId, spki, role };
}

export interface CuratedDevOverrides {
  keys: CuratedKey[];
  /** `B4M_CURATED_DEV_URL`, read at run time; null when unset. */
  url: string | null;
}

/**
 * The test keys and URL override, for a build that compiled them in; never for a packaged app. Callers reach this
 * only behind `__B4M_CURATED_DEV_KEYS__`, so a release build drops this module and the seeds with it.
 */
export function curatedDevOverrides(
  packaged: boolean,
  env: Record<string, string | undefined>
): CuratedDevOverrides | null {
  if (packaged) return null;
  return { keys: [curatedDevKey('signing'), curatedDevKey('recovery')], url: env.B4M_CURATED_DEV_URL?.trim() || null };
}
