import { useMemo } from 'react';
import {
  type ApiKeyScopeAccess,
  type ApiKeyScopeOption,
  genericApiKeyScopesFor,
} from '@client/app/constants/apiKeyScopes';
import { useOptiAccess } from '@client/app/hooks/data/opti';
import { useHearthEnabled, useOverwatchAccess } from '@client/app/hooks/data/productScopeAccess';

/** The current user's product access, for gating product scopes (see ApiKeyScopeAccess). */
export function useApiKeyScopeAccess(): ApiKeyScopeAccess {
  const hasOptiAccess = useOptiAccess();
  const hasOverwatchAccess = useOverwatchAccess();
  const hearthEnabled = useHearthEnabled();
  return useMemo(
    () => ({ hasOptiAccess, hasOverwatchAccess, hearthEnabled }),
    [hasOptiAccess, hasOverwatchAccess, hearthEnabled]
  );
}

/** The generic New-Key scopes the current user may see: product scopes only where the user has that product. */
export function useGenericApiKeyScopes(): ApiKeyScopeOption[] {
  return genericApiKeyScopesFor(useApiKeyScopeAccess());
}
