import { oauthClientSourceSlug } from '@bike4mind/common';

export const OAUTH_SOURCE_TAG_PREFIX = 'source:';

/** Narrow client lookup, so this package stays free of @bike4mind/database. */
export interface OAuthSourceClientLookup {
  findByClientId(clientId: string): Promise<{ clientId: string; isActive: boolean } | null>;
}

/**
 * The `source:<slug>` tag for a signup that came through a registered OAuth client, or null.
 * The slug is derived from the stored client record, never from the request, and only an
 * active client yields one.
 */
export async function resolveOAuthSourceTag(
  clientId: unknown,
  lookup: OAuthSourceClientLookup
): Promise<string | null> {
  if (typeof clientId !== 'string' || clientId.length === 0) return null;
  const client = await lookup.findByClientId(clientId);
  if (!client || client.isActive !== true) return null;
  const slug = oauthClientSourceSlug(client.clientId);
  return slug ? `${OAUTH_SOURCE_TAG_PREFIX}${slug}` : null;
}
