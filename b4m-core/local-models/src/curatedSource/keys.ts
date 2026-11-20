import { parseCuratedKey, type CuratedKey } from '../curatedSignature';
// The one keyring Desktop, the CLI and packages/scripts curatedCatalog read; curated:publish reads it from main.
import keyring from '../../../../catalog/model-hub/keys.json';

/**
 * The production keys this build trusts for the Bike4Mind list. Empty until the owner generates them, which keeps
 * the remote list off: a build can only ever trust keys it shipped with.
 */
export const PRODUCTION_CURATED_KEYS: readonly CuratedKey[] = (keyring as unknown[]).flatMap(entry => {
  const key = parseCuratedKey(entry);
  return key ? [key] : [];
});
