import { createHash } from 'node:crypto';
import { curatedKeyFromSeed } from '@bike4mind/local-models';

// Must stay in sync with apps/desktop/src/main/models/curated/devKey.ts. The seed is public, so lists only this key
// signed are refused at publish, and a release build must not contain it.
export const CURATED_DEV_SEED_TEXT = 'b4m-model-hub-curated-test-key';

export function curatedDevKey() {
  return curatedKeyFromSeed(createHash('sha256').update(CURATED_DEV_SEED_TEXT).digest());
}
