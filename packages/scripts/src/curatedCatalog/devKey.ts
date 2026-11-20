import { createHash } from 'node:crypto';
import { curatedKeyFromSeed, type CuratedKeyRole } from '@bike4mind/local-models';

// Must stay in sync with apps/desktop/src/main/models/curated/devKey.ts, packages/cli/src/models/curatedDevKey.ts and
// packages/server-utils/src/modelHub/curatedDevKeys.ts (whose test checks all four).
// The seeds are public: lists only these keys signed are refused at publish, and a release build must not contain them.
export const CURATED_DEV_SEED_TEXTS: Record<CuratedKeyRole, string> = {
  signing: 'b4m-model-hub-curated-test-key',
  recovery: 'b4m-model-hub-curated-test-recovery-key',
};

export function curatedDevKey(role: CuratedKeyRole = 'signing') {
  const key = curatedKeyFromSeed(createHash('sha256').update(CURATED_DEV_SEED_TEXTS[role]).digest());
  return { ...key, role };
}

export const curatedDevKeys = () => [curatedDevKey('signing'), curatedDevKey('recovery')];
