import { useMemo } from 'react';
import {
  type ApiKeyScopeAccess,
  type ApiKeyScopeOption,
  genericApiKeyScopesFor,
} from '@bike4mind/server-utils/app/constants/apiKeyScopes';
import { useOptiAccess } from '@client/app/hooks/data/opti';
import {
  useApiKeyScopeEntitlements,
  useHearthEnabled,
  useOverwatchAccess,
} from '@client/app/hooks/data/productScopeAccess';

/** The current user's product access, for gating product scopes (see ApiKeyScopeAccess). */
export function useApiKeyScopeAccess(): ApiKeyScopeAccess {
  const hasOptiAccess = useOptiAccess();
  const hasOverwatchAccess = useOverwatchAccess();
  const hearthEnabled = useHearthEnabled();
  const { bypass, entitlements } = useApiKeyScopeEntitlements();
  return useMemo(
    () => ({ hasOptiAccess, hasOverwatchAccess, hearthEnabled, bypass, entitlements }),
    [hasOptiAccess, hasOverwatchAccess, hearthEnabled, bypass, entitlements]
  );
}

/** The generic New-Key scopes the current user may see: product scopes only where the user has that product. */
export function useGenericApiKeyScopes(): ApiKeyScopeOption[] {
  return genericApiKeyScopesFor(useApiKeyScopeAccess());
}
