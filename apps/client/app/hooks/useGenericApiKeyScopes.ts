import { useMemo } from 'react';
import {
  type ApiKeyScopeAccess,
  type ApiKeyScopeOption,
  genericApiKeyScopesFor,
} from '@client/app/constants/apiKeyScopes';
import { useOptiAccess, useOptiVisible } from '@client/app/hooks/data/opti';
import { useHearthEnabled, useOverwatchAccess } from '@client/app/hooks/data/productScopeAccess';

/**
 * The current user's product access, for gating product scopes (see ApiKeyScopeAccess). With
 * `respectHiddenSurfaces`, a workspace the user hid from their own UI also drops its scopes; only the
 * self-service views pass it, since admin views and the mint route gate on access alone.
 */
export function useApiKeyScopeAccess({ respectHiddenSurfaces = false } = {}): ApiKeyScopeAccess {
  const optiAccess = useOptiAccess();
  const optiVisible = useOptiVisible();
  const hasOptiAccess = respectHiddenSurfaces ? optiVisible : optiAccess;
  const hasOverwatchAccess = useOverwatchAccess();
  const hearthEnabled = useHearthEnabled();
  return useMemo(
    () => ({ hasOptiAccess, hasOverwatchAccess, hearthEnabled }),
    [hasOptiAccess, hasOverwatchAccess, hearthEnabled]
  );
}

/** The generic New-Key scopes the current user may see: product scopes only where the user has that product. */
export function useGenericApiKeyScopes(options?: { respectHiddenSurfaces?: boolean }): ApiKeyScopeOption[] {
  return genericApiKeyScopesFor(useApiKeyScopeAccess(options));
}
