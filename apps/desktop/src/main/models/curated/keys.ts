import { parseCuratedKey, type CuratedKey } from '@bike4mind/local-models';
// Also read as plain JSON from origin/main by packages/scripts/src/curatedCatalog/publishCurated.ts.
import keyring from './keys.json';

/**
 * The production keys this build trusts for the Bike4Mind list. Empty until the owner generates them, which keeps
 * the remote list off: a build can only ever trust keys it shipped with.
 */
export const PRODUCTION_CURATED_KEYS: readonly CuratedKey[] = (keyring as unknown[]).flatMap(entry => {
  const key = parseCuratedKey(entry);
  return key ? [key] : [];
});
