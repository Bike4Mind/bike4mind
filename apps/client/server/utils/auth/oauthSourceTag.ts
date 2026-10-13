import { oauthClientRepository, User } from '@bike4mind/database';
import { userService } from '@bike4mind/services';

/**
 * Tags a brand-new SSO account with the `source:<slug>` of the OAuth client its signup came
 * through. clientId comes from the verified state JWT (OAuth, Okta) or the unsigned SAML
 * RelayState; either way only an active registered client yields a tag. Attribution must not
 * fail a login, so errors are logged and swallowed.
 */
export async function stampOAuthSourceTag(userId: string, clientId: unknown): Promise<void> {
  try {
    const tag = await userService.resolveOAuthSourceTag(clientId, oauthClientRepository);
    if (!tag) return;
    await User.updateOne({ _id: userId }, { $addToSet: { tags: tag } });
  } catch (err) {
    console.warn('[oauthSourceTag] Failed to stamp source tag for OAuth client', clientId, err);
  }
}
