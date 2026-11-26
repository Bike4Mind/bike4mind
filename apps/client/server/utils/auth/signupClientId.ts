import { clientIdFromAuthorizeRedirect } from '@bike4mind/common';
import { oauthClientRepository } from '@bike4mind/database';
import { userService } from '@bike4mind/services';
import { Logger } from '@bike4mind/observability';

const logger = new Logger({ metadata: { service: 'signupClientId' } });

/**
 * The IUser.signupClientId for an account created with this post-login redirectTo: the stored id
 * of the active OAuth client whose /oauth/authorize URL it is, else null. Shared by every sign-up
 * path (the OTC path resolves the same way in registerUser). Attribution must not fail a sign-up,
 * so a failed lookup yields null.
 */
export async function resolveSignupClientId(redirectTo: unknown): Promise<string | null> {
  const clientId = clientIdFromAuthorizeRedirect(redirectTo);
  if (!clientId) return null;
  try {
    return await userService.resolveActiveOAuthClientId(clientId, oauthClientRepository);
  } catch (err) {
    logger.warn('Failed to resolve the OAuth client a sign-up came through', { clientId, error: err });
    return null;
  }
}

/** The redirectTo a SAML callback request carries in its RelayState (see pages/api/auth/saml/callback.ts). */
export function samlRelayRedirectTo(req: { method?: string; body?: unknown; query?: unknown }): string | undefined {
  const source = req.method === 'POST' ? req.body : req.query;
  const relayState =
    typeof source === 'object' && source !== null && 'RelayState' in source ? source.RelayState : undefined;
  if (typeof relayState !== 'string') return undefined;
  return new URLSearchParams(relayState).get('redirectTo') || undefined;
}
