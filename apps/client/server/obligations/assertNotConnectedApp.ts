import { ForbiddenError } from '@bike4mind/common';

/** An obligation reads the user's files, spends credits and files into lakes, none of which a connected app is granted. */
export function assertNotConnectedApp(apiKeyInfo: { oauthExchangeClientId?: string | null } | undefined): void {
  if (apiKeyInfo?.oauthExchangeClientId) {
    throw new ForbiddenError('Keys minted for a connected app cannot use obligations');
  }
}
