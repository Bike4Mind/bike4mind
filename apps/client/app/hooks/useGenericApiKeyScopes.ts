import { type ApiKeyScopeOption, genericApiKeyScopesFor } from '@client/app/constants/apiKeyScopes';
import { useOptiAccess } from '@client/app/hooks/data/opti';

/** The generic New-Key scopes the current user may see: premium OptiHashi scopes only with Opti access. */
export function useGenericApiKeyScopes(): ApiKeyScopeOption[] {
  return genericApiKeyScopesFor(useOptiAccess());
}
