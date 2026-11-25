import {
  DATA_LAKE_READ_API_KEY_SCOPES,
  DATA_LAKE_WRITE_API_KEY_SCOPES,
  ForbiddenError,
  type ApiKeyScope,
} from '@bike4mind/common';

type KeyInfo = { scopes?: readonly string[] } | undefined;

// A signed-in session holds every lake right; an API key needs the same data-lake scopes the
// /api/v1/data-lakes contracts (dataLakes.contract.ts) require, on top of the obligation routes' AI scopes.
const keyHoldsAny = (apiKeyInfo: KeyInfo, scopes: readonly ApiKeyScope[]): boolean =>
  !apiKeyInfo || scopes.some(scope => apiKeyInfo.scopes?.includes(scope) === true);

/** Whether the caller may see lake names: suggested destinations and an obligation's `destination`. */
export const canReadObligationLakes = (apiKeyInfo: KeyInfo): boolean =>
  keyHoldsAny(apiKeyInfo, DATA_LAKE_READ_API_KEY_SCOPES);

/** Whether the caller may choose or file into a lake, and so whether a hand-off suggests one. */
export const canFileObligationIntoLakes = (apiKeyInfo: KeyInfo): boolean =>
  keyHoldsAny(apiKeyInfo, DATA_LAKE_WRITE_API_KEY_SCOPES);

export function assertCanFileObligationIntoLakes(apiKeyInfo: KeyInfo): void {
  if (!canFileObligationIntoLakes(apiKeyInfo)) {
    throw new ForbiddenError('Choosing or filing into a data lake needs a key with the datalake:write scope');
  }
}
